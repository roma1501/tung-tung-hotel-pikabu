/*
 * Playgama Bridge v2 surface on top of the Pikabu Games SDK (PkbSDK, https://games.pikabu.ru/sdk/docs).
 * Loaded right after https://games.pikabu.ru/sdk/sdk.js and before the game code, in place of
 * https://bridge.playgama.com/v2/stable/playgama-bridge.js — the game code (and playgama-yandex-shim.js
 * for games written against YaGames) stays unchanged.
 *  - initialize(): PkbSDK.init() with a 15 s timeout. Without the SDK (ad blocker, local run) the game
 *    still starts: localStorage saves, no ads. Never rejects.
 *  - platform.language is always 'ru' (Pikabu: Russian interface by default); navigator.language too.
 *  - sendMessage('game_ready') → sdk.gameStarted() once (fallback 25 s after init).
 *  - storage: sdk.storage (cloud, 200 KB) — values are stored exactly as the game passes them;
 *    flushed when the page is hidden; REVISION_CONFLICT pauses the game and offers a reload.
 *  - advertisement: fullscreen / rewarded via canShow() → show(); states loading → opened →
 *    (rewarded) → closed | failed; the reward only when show() returns reward === true.
 *  - pause / audio: a hidden tab, an open ad or a save conflict pause the game and mute it
 *    (PAUSE_STATE_CHANGED, AUDIO_STATE_CHANGED, VISIBILITY_STATE_CHANGED).
 *  - localStorage is namespaced by the page path: all *-pikabu builds share one origin.
 *  - No leaderboards, payments, achievements, sharing or in-game sign-in.
 */
(function () {
  'use strict';
  if (window.bridge && window.bridge.__pikabu) return;

  var INIT_TIMEOUT = 15000, CAN_SHOW_TIMEOUT = 4000, AD_TIMEOUT = 180000, READY_FALLBACK = 25000;
  var LS_PREFIX = 'pkb:';
  var debug = { log: [] };
  function note(what) { if (debug.log.length < 300) debug.log.push([Math.round(performance.now()), what]); }
  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  function later(fn) { setTimeout(function () { safe(fn); }, 0); }
  function withTimeout(p, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(label + ' timed out')); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // ---------- localStorage per game ----------
  // Every *-pikabu build is hosted on the same origin (roma1501.github.io/<repo>/), so games built on one
  // engine would overwrite each other's keys, and the YaGames adapter would mirror other games' keys into
  // this game's cloud save. The game sees only its own keys: they are stored as '<path>|<key>'.
  safe(function () {
    var SP = window.Storage && Storage.prototype;
    var ls = window.localStorage;
    if (!SP || !ls || SP.__pkbNs) return;
    var ns = location.pathname.replace(/[^/]*$/, '') + '|';
    var nGet = SP.getItem, nSet = SP.setItem, nRemove = SP.removeItem, nKey = SP.key;
    var lenDesc = Object.getOwnPropertyDescriptor(SP, 'length');
    var nLen = lenDesc && lenDesc.get;
    function mine(s) { return s === ls; }
    function own() {
      var out = [], n = nLen.call(ls);
      for (var i = 0; i < n; i++) { var k = nKey.call(ls, i); if (k != null && k.indexOf(ns) === 0) out.push(k.slice(ns.length)); }
      return out;
    }
    SP.getItem = function (k) { return mine(this) ? nGet.call(this, ns + String(k)) : nGet.apply(this, arguments); };
    SP.setItem = function (k, v) { return mine(this) ? nSet.call(this, ns + String(k), v) : nSet.apply(this, arguments); };
    SP.removeItem = function (k) { return mine(this) ? nRemove.call(this, ns + String(k)) : nRemove.apply(this, arguments); };
    SP.key = function (i) { if (!mine(this)) return nKey.apply(this, arguments); var a = own(); return i >= 0 && i < a.length ? a[i] : null; };
    var nClear = SP.clear;
    SP.clear = function () { if (!mine(this)) return nClear.apply(this, arguments); var self = this; own().forEach(function (k) { nRemove.call(self, ns + k); }); };
    if (nLen) Object.defineProperty(SP, 'length', { configurable: true, enumerable: true, get: function () { return mine(this) ? own().length : nLen.call(this); } });
    SP.__pkbNs = ns;
  });

  // ---------- Russian by default ----------
  safe(function () {
    var NP = window.Navigator && Navigator.prototype;
    Object.defineProperty(NP, 'language', { configurable: true, get: function () { return 'ru-RU'; } });
    Object.defineProperty(NP, 'languages', { configurable: true, get: function () { return ['ru-RU', 'ru']; } });
  });
  safe(function () { document.documentElement.setAttribute('lang', 'ru'); });

  var EVENT_NAME = {
    INTERSTITIAL_STATE_CHANGED: 'interstitial_state_changed',
    REWARDED_STATE_CHANGED: 'rewarded_state_changed',
    BANNER_STATE_CHANGED: 'banner_state_changed',
    VISIBILITY_STATE_CHANGED: 'visibility_state_changed',
    AUDIO_STATE_CHANGED: 'audio_state_changed',
    PAUSE_STATE_CHANGED: 'pause_state_changed',
    LEADERBOARD_STATE_CHANGED: 'leaderboard_state_changed'
  };

  // ---------- one event bus behind every module's on/off ----------
  var listeners = {};
  function on(name, fn) { if (typeof fn === 'function') (listeners[name] = listeners[name] || []).push(fn); }
  function off(name, fn) { listeners[name] = (listeners[name] || []).filter(function (h) { return h !== fn; }); }
  function emit(name, arg) {
    (listeners[name] || []).slice().forEach(function (fn) {
      try { fn(arg); } catch (e) { console.error('[pikabu-bridge] listener failed', e); }
    });
  }

  var sdk = null;
  var initPromise = null;

  // ---------- pause / audio causes ----------
  var causes = { hidden: !!document.hidden, ad: false, conflict: false };
  var lastPaused = null, lastAudio = null;
  function anyCause() { return causes.hidden || causes.ad || causes.conflict; }
  function syncState() {
    var paused = anyCause();
    var audio = !paused;
    if (paused !== lastPaused) { lastPaused = paused; note('pause:' + paused); emit(EVENT_NAME.PAUSE_STATE_CHANGED, paused); }
    if (audio !== lastAudio) { lastAudio = audio; note('audio:' + audio); emit(EVENT_NAME.AUDIO_STATE_CHANGED, audio); }
  }
  document.addEventListener('visibilitychange', function () {
    causes.hidden = !!document.hidden;
    emit(EVENT_NAME.VISIBILITY_STATE_CHANGED, document.hidden ? 'hidden' : 'visible');
    if (document.hidden) flushStorage();
    syncState();
  });
  window.addEventListener('pagehide', function () { flushStorage(); });

  // ---------- storage ----------
  function lsGet(k) {
    var v = safe(function () { return localStorage.getItem(LS_PREFIX + k); });
    if (v == null) return null;
    var o = safe(function () { return JSON.parse(v); });
    return o && typeof o === 'object' && 'v' in o ? o.v : null;
  }
  function lsSet(k, v) { safe(function () { localStorage.setItem(LS_PREFIX + k, JSON.stringify({ v: v })); }); }
  function lsDel(k) { safe(function () { localStorage.removeItem(LS_PREFIX + k); }); }
  function readKey(k) {
    k = String(k);
    if (sdk) { var v = safe(function () { return sdk.storage.get(k); }); return v === undefined ? null : v; }
    return lsGet(k);
  }
  function writeKey(k, v) {
    k = String(k);
    if (v === undefined) v = null;
    if (sdk) sdk.storage.set(k, v); else lsSet(k, v);
  }
  function deleteKey(k) {
    k = String(k);
    if (sdk) safe(function () { sdk.storage.remove(k); }); else lsDel(k);
  }
  var flushTimer = 0;
  function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flushStorage, 1500); }
  function flushStorage() {
    clearTimeout(flushTimer); flushTimer = 0;
    if (!sdk || !sdk.storage || typeof sdk.storage.flush !== 'function') return;
    safe(function () {
      Promise.resolve(sdk.storage.flush()).then(function (r) { if (r && r.success === false) note('flush:' + r.reason); }, function () {});
    });
  }
  var conflictShown = false;
  function conflictNotice() {
    if (conflictShown) return;
    conflictShown = true;
    causes.conflict = true;
    syncState();
    safe(function () {
      var box = document.createElement('div');
      box.id = 'pkb-conflict';
      box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(8,10,18,.82);font:700 17px/1.35 system-ui,sans-serif;color:#fff;text-align:center';
      var card = document.createElement('div');
      card.style.cssText = 'box-sizing:border-box;width:calc(100% - 32px);max-width:420px;padding:22px 18px;border-radius:20px;' +
        'background:#1e2233;border:3px solid #7d8bff;box-shadow:0 18px 40px rgba(0,0,0,.55)';
      var title = document.createElement('div');
      title.style.cssText = 'font-weight:900;font-size:23px;line-height:1.15;margin-bottom:10px';
      title.textContent = 'Игра открыта ещё где-то';
      var text = document.createElement('div');
      text.style.cssText = 'font-weight:600;font-size:15px;opacity:.85;margin-bottom:16px';
      text.textContent = 'Прогресс изменился на другом устройстве или в другой вкладке. Перезагрузите игру, чтобы продолжить сохраняться.';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = 'min-height:50px;padding:10px 26px;border-radius:14px;cursor:pointer;font-weight:900;font-size:18px;' +
        'color:#fff;background:#3fae2a;border:0;border-bottom:5px solid #23701a';
      btn.textContent = 'Перезагрузить';
      btn.addEventListener('click', function () { location.reload(); });
      card.appendChild(title); card.appendChild(text); card.appendChild(btn); box.appendChild(card);
      (document.body || document.documentElement).appendChild(box);
    });
  }
  function many(keys, fn) { return Array.isArray(keys) ? keys.map(function (k) { return fn(k); }) : fn(keys); }
  var storage = {
    get defaultType() { return 'platform_internal'; },
    isSupported: function () { return true; },
    isAvailable: function () { return true; },
    get: function (keys) {
      return ready().then(function () { return many(keys, readKey); });
    },
    set: function (keys, values) {
      return ready().then(function () {
        if (Array.isArray(keys)) keys.forEach(function (k, i) { writeKey(k, Array.isArray(values) ? values[i] : values); });
        else writeKey(keys, values);
        scheduleFlush();
      });
    },
    delete: function (keys) {
      return ready().then(function () { many(keys, deleteKey); scheduleFlush(); });
    }
  };

  // ---------- ads ----------
  var adBusy = false;
  var adState = { interstitial: null, rewarded: null };
  function adUnit(kind) { return sdk && safe(function () { return sdk.ads[kind === 'rewarded' ? 'rewarded' : 'fullscreen']; }) || null; }
  function adSupported(kind) { var u = adUnit(kind); return !!(u && u.isSupported); }
  function setAdState(kind, s) {
    adState[kind] = s;
    note(kind + ':' + s);
    emit(kind === 'rewarded' ? EVENT_NAME.REWARDED_STATE_CHANGED : EVENT_NAME.INTERSTITIAL_STATE_CHANGED, s);
  }
  function showAd(kind) {
    return ready().then(function () {
      var unit = adUnit(kind);
      if (adBusy) { note(kind + ':busy'); return; }
      if (!unit || !unit.isSupported) { later(function () { setAdState(kind, 'failed'); }); return; }
      adBusy = true;
      setAdState(kind, 'loading');
      return withTimeout(Promise.resolve().then(function () { return unit.canShow(); }), CAN_SHOW_TIMEOUT, 'canShow').then(function (can) {
        if (can !== true) { setAdState(kind, 'failed'); return; }
        causes.ad = true;
        syncState();
        setAdState(kind, 'opened');
        return withTimeout(Promise.resolve().then(function () { return unit.show(); }), AD_TIMEOUT, 'show').then(function (r) {
          causes.ad = false;
          syncState();
          if (!r || r.rendered === false) { note(kind + ':not_rendered:' + (r && r.reason)); setAdState(kind, 'failed'); return; }
          if (kind === 'rewarded' && r.reward === true) setAdState(kind, 'rewarded');
          setAdState(kind, 'closed');
        });
      }).catch(function (e) {
        note(kind + ':error:' + (e && e.message));
        if (causes.ad) { causes.ad = false; syncState(); }
        setAdState(kind, 'failed');
      }).then(function () { adBusy = false; });
    });
  }
  var advertisement = {
    get isInterstitialSupported() { return adSupported('interstitial'); },
    get isRewardedSupported() { return adSupported('rewarded'); },
    get isBannerSupported() { return false; },
    get interstitialState() { return adState.interstitial; },
    get rewardedState() { return adState.rewarded; },
    get bannerState() { return 'hidden'; },
    get minimumDelayBetweenInterstitial() { return 120; },
    setMinimumDelayBetweenInterstitial: function () {},
    showInterstitial: function () { return showAd('interstitial'); },
    showRewarded: function () { return showAd('rewarded'); },
    showBanner: function () { later(function () { emit(EVENT_NAME.BANNER_STATE_CHANGED, 'failed'); }); },
    hideBanner: function () {},
    checkAdBlock: function () { return ready().then(function () { return !sdk; }); },
    on: on,
    off: off
  };

  // ---------- platform ----------
  var gameStartedSent = false;
  function gameStarted() {
    if (gameStartedSent || !sdk) return;
    gameStartedSent = true;
    note('gameStarted');
    safe(function () { sdk.gameStarted(); });
  }
  var platform = {
    get id() { return 'pikabu'; },
    get language() { return 'ru'; },
    get tld() { return 'ru'; },
    get payload() { return null; },
    get isAudioEnabled() { return !anyCause(); },
    get isPaused() { return anyCause(); },
    get isGetAllGamesSupported() { return false; },
    get isGetGameByIdSupported() { return false; },
    sendMessage: function (message) {
      var m = String(message || '');
      note('message:' + m);
      if (m === 'game_ready') ready().then(gameStarted);
      return Promise.resolve();
    },
    getServerTime: function () { return Promise.resolve(Date.now()); },
    getAllGames: function () { return Promise.resolve([]); },
    getGameById: function () { return Promise.reject(new Error('Not supported on Pikabu')); },
    on: on,
    off: off
  };

  function deviceType() {
    var ua = navigator.userAgent || '';
    if (/iPad|Tablet/i.test(ua)) return 'tablet';
    if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
    var coarse = safe(function () { return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches; });
    return coarse ? 'mobile' : 'desktop';
  }
  function notSupported() { return Promise.reject(new Error('Not supported on Pikabu')); }

  var player = {
    get isAuthorizationSupported() { return false; },
    get isAuthorized() { return !!(sdk && safe(function () { return sdk.player.isAuthorized; })); },
    get id() { return sdk ? String(safe(function () { return sdk.player.id; }) || '') : ''; },
    get name() { return this.isAuthorized ? String(safe(function () { return sdk.player.name; }) || '') : ''; },
    get photos() { var a = this.isAuthorized && safe(function () { return sdk.player.avatar; }); return a ? [String(a)] : []; },
    get extra() { return {}; },
    authorize: notSupported
  };

  function ready() { return initPromise || bridge.initialize(); }

  var bridge = {
    __pikabu: debug,
    get version() { return '2-pikabu'; },
    get engine() { return 'javascript'; },
    get isInitialized() { return !!debug.initialized; },
    EVENT_NAME: EVENT_NAME,
    STORAGE_TYPE: { LOCAL_STORAGE: 'local_storage', PLATFORM_INTERNAL: 'platform_internal' },
    PLATFORM_ID: { PIKABU: 'pikabu', MOCK: 'mock' },
    PLATFORM_MESSAGE: {
      GAME_READY: 'game_ready', IN_GAME_LOADING_STARTED: 'in_game_loading_started', IN_GAME_LOADING_STOPPED: 'in_game_loading_stopped',
      GAMEPLAY_STARTED: 'gameplay_started', GAMEPLAY_STOPPED: 'gameplay_stopped', PLAYER_GOT_ACHIEVEMENT: 'player_got_achievement'
    },
    INTERSTITIAL_STATE: { LOADING: 'loading', OPENED: 'opened', CLOSED: 'closed', FAILED: 'failed' },
    REWARDED_STATE: { LOADING: 'loading', OPENED: 'opened', REWARDED: 'rewarded', CLOSED: 'closed', FAILED: 'failed' },
    BANNER_STATE: { LOADING: 'loading', SHOWN: 'shown', HIDDEN: 'hidden', FAILED: 'failed' },
    VISIBILITY_STATE: { VISIBLE: 'visible', HIDDEN: 'hidden' },
    DEVICE_TYPE: { DESKTOP: 'desktop', MOBILE: 'mobile', TABLET: 'tablet', TV: 'tv' },
    LEADERBOARD_TYPE: { NOT_AVAILABLE: 'not_available', IN_GAME: 'in_game', NATIVE: 'native', NATIVE_POPUP: 'native_popup' },
    initialize: function () {
      if (initPromise) return initPromise;
      initPromise = withTimeout(Promise.resolve().then(function () {
        if (!window.PkbSDK || typeof PkbSDK.init !== 'function') throw new Error('Pikabu SDK did not load');
        return PkbSDK.init();
      }), INIT_TIMEOUT, 'PkbSDK.init').then(function (s) {
        sdk = s || null;
        note('sdk:ready');
        safe(function () {
          sdk.on('storageSaveError', function (reason) {
            console.warn('[pikabu-bridge] save failed:', reason);
            note('save_error:' + reason);
            if (reason === 'REVISION_CONFLICT') conflictNotice();
          });
        });
      }, function (e) {
        sdk = null;
        console.warn('[pikabu-bridge] playing without the Pikabu SDK:', (e && e.message) || e);
        note('sdk:none');
      }).then(function () {
        debug.initialized = true;
        lastPaused = anyCause();
        lastAudio = !lastPaused;
        setTimeout(gameStarted, READY_FALLBACK);
      });
      return initPromise;
    },
    platform: platform,
    game: {
      get visibilityState() { return document.hidden ? 'hidden' : 'visible'; },
      on: on,
      off: off
    },
    device: { get type() { return deviceType(); } },
    player: player,
    storage: storage,
    advertisement: advertisement,
    leaderboards: {
      get type() { return 'not_available'; },
      get isSupported() { return false; },
      get isSetScoreSupported() { return false; },
      get isGetEntriesSupported() { return false; },
      setScore: notSupported,
      getEntries: notSupported,
      showNativePopup: notSupported,
      on: on,
      off: off
    },
    payments: {
      get isSupported() { return false; },
      purchase: notSupported, consumePurchase: notSupported, getCatalog: notSupported, getPurchases: notSupported
    },
    achievements: {
      get isSupported() { return false; },
      get isGetListSupported() { return false; },
      get isNativePopupSupported() { return false; },
      unlock: notSupported, getList: notSupported, showNativePopup: notSupported
    },
    social: {
      get isShareSupported() { return false; },
      get isInviteFriendsSupported() { return false; },
      get isJoinCommunitySupported() { return false; },
      get isCreatePostSupported() { return false; },
      get isAddToHomeScreenSupported() { return false; },
      get isAddToFavoritesSupported() { return false; },
      get isRateSupported() { return false; },
      get isExternalLinksAllowed() { return false; },
      share: notSupported, inviteFriends: notSupported, joinCommunity: notSupported, createPost: notSupported,
      addToHomeScreen: notSupported, addToFavorites: notSupported, rate: notSupported
    },
    remoteConfig: { get isSupported() { return false; }, get: notSupported },
    clipboard: {
      get isSupported() { return false; },
      read: notSupported,
      write: function (t) { return Promise.resolve(safe(function () { return navigator.clipboard.writeText(t); })).catch(function () {}); }
    }
  };
  window.bridge = bridge;
  bridge.initialize();
})();
