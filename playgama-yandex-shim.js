/*
 * Playgama Bridge v2 adapter for games written against the Yandex Games SDK.
 * Loaded right after https://bridge.playgama.com/v2/stable/playgama-bridge.js and before the game code.
 * Exposes window.YaGames and maps it to Bridge: initialize, platform.language, game_ready,
 * pause/audio events, interstitial/rewarded ads and storage (player data + localStorage mirror).
 *
 * bridge.platform.language is read exactly once, right after bridge.initialize(), and cached:
 * Playgama moderation rejects games that query it repeatedly (Ref: lang-error-2).
 */
(function () {
  'use strict';
  if (window.__playgamaYandexShim) return;
  var debug = { log: [] };
  window.__playgamaYandexShim = debug;
  function note(what) { if (debug.log.length < 200) debug.log.push([Math.round(performance.now()), what]); }

  var bridge = window.bridge;
  function getBridge() { return bridge || (bridge = window.bridge); }
  var SAVE_KEY = 'ya_player_data';
  var STATS_KEY = 'ya_player_stats';
  var LS_KEY = 'local_storage_snapshot';
  var state = { paused: false, audioEnabled: true, adOpen: false, ready: false, gameplay: 'idle' };
  var cache = { data: {}, stats: {} };
  // ISO 639-1 code from bridge.platform.language, filled once in initBridge(). English is the baseline.
  var language = null;
  debug.state = state;
  var handlers = {};
  var lsProto = window.Storage && Storage.prototype;
  var lsSet = lsProto && lsProto.setItem;
  var lsRemove = lsProto && lsProto.removeItem;
  var lsClear = lsProto && lsProto.clear;

  function hasBridge() { var b = getBridge(); return !!(b && b.isInitialized && b.platform); }
  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  function later(fn) { setTimeout(function () { safe(fn); }, 0); }
  function timeout(p, ms) { return Promise.race([p, new Promise(function (r) { setTimeout(r, ms); })]); }
  function parse(v) { if (v == null || v === '') return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return null; } }

  // ---------- audio: mute everything while paused, ad is open or the platform disabled audio ----------
  var contexts = [];
  var media = new Set();
  function silenced() { return state.paused || state.adOpen || !state.audioEnabled; }
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Native = window[name];
    if (!Native || Native.__pgWrapped) return;
    var nativeResume = Native.prototype.resume;
    Native.prototype.resume = function () {
      if (silenced()) return Promise.resolve();
      return nativeResume.apply(this, arguments);
    };
    var Wrapped = function () {
      var ctx = Reflect.construct(Native, arguments, new.target || Wrapped);
      contexts.push(ctx);
      if (silenced()) safe(function () { ctx.suspend(); });
      return ctx;
    };
    Wrapped.prototype = Native.prototype;
    Wrapped.__pgWrapped = true;
    Wrapped.__pgResume = nativeResume;
    Object.setPrototypeOf(Wrapped, Native);
    window[name] = Wrapped;
  });
  if (window.HTMLMediaElement) {
    var nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      media.add(this);
      if (silenced()) { this.__pgMuted = this.__pgMuted || !this.muted; this.muted = true; }
      return nativePlay.apply(this, arguments);
    };
  }
  function applyAudio() {
    var mute = silenced();
    contexts.forEach(function (ctx) {
      safe(function () {
        if (mute) { if (ctx.state === 'running') ctx.suspend(); }
        else if (ctx.state === 'suspended') {
          var ctor = window.AudioContext || window.webkitAudioContext;
          (ctor.__pgResume || ctx.resume).call(ctx);
        }
      });
    });
    media.forEach(function (el) {
      if (mute) { if (!el.muted) { el.__pgMuted = true; el.muted = true; } }
      else if (el.__pgMuted) { el.__pgMuted = false; el.muted = false; }
    });
  }

  // ---------- events for game code (ysdk.on('game_api_pause' | 'game_api_resume')) ----------
  function emit(name) {
    (handlers[name] || []).slice().forEach(function (fn) { safe(fn); });
  }
  var lastPauseEmit = false;
  function syncPause() {
    applyAudio();
    var p = state.paused;
    if (p === lastPauseEmit) return;
    lastPauseEmit = p;
    emit(p ? 'game_api_pause' : 'game_api_resume');
  }

  // ---------- storage ----------
  function isServiceKey(k) {
    return /ya_player_data|ya_player_stats|local_storage_snapshot|bridge|playgama/i.test(k);
  }
  var lastSnapshot = null;
  var snapshotTimer = 0;
  function snapshot() {
    var out = {};
    safe(function () {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!isServiceKey(k)) out[k] = localStorage.getItem(k);
      }
    });
    return JSON.stringify(out);
  }
  function scheduleSnapshot() {
    if (!state.ready) return;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(function () {
      var s = snapshot();
      if (s === lastSnapshot) return;
      lastSnapshot = s;
      storageSet(LS_KEY, s);
    }, 800);
  }
  if (lsProto) {
    lsProto.setItem = function (k, v) {
      var r = lsSet.apply(this, arguments);
      if (this === safe(function () { return window.localStorage; }) && !isServiceKey(String(k))) scheduleSnapshot();
      return r;
    };
    lsProto.removeItem = function (k) {
      var r = lsRemove.apply(this, arguments);
      if (this === safe(function () { return window.localStorage; }) && !isServiceKey(String(k))) scheduleSnapshot();
      return r;
    };
    lsProto.clear = function () {
      var r = lsClear.apply(this, arguments);
      if (this === safe(function () { return window.localStorage; })) scheduleSnapshot();
      return r;
    };
  }
  function storageSet(key, value) {
    if (!state.ready || !hasBridge() || !bridge.storage) return Promise.resolve();
    return Promise.resolve(safe(function () { return bridge.storage.set([key], [value]); })).catch(function () {});
  }

  // ---------- Bridge initialization ----------
  var initPromise = null;
  function initBridge() {
    if (initPromise) return initPromise;
    initPromise = (async function () {
      var b = getBridge();
      if (!b || typeof b.initialize !== 'function') { note('no_bridge'); return; }
      try { await timeout(b.initialize(), 10000); } catch (e) { console.warn('[playgama] Bridge initialize failed', e); }
      if (!hasBridge()) { note('bridge_init_failed'); state.ready = true; return; }
      // the only read of platform.language: right after initialization
      language = normalizeLang(safe(function () { return bridge.platform.language; }));
      debug.language = language;
      state.audioEnabled = safe(function () { return bridge.platform.isAudioEnabled; }) !== false;
      state.paused = safe(function () { return bridge.platform.isPaused; }) === true;
      safe(function () {
        bridge.platform.on(bridge.EVENT_NAME.PAUSE_STATE_CHANGED, function (p) { state.paused = !!p; syncPause(); });
        bridge.platform.on(bridge.EVENT_NAME.AUDIO_STATE_CHANGED, function (on) { state.audioEnabled = !!on; applyAudio(); });
      });
      try {
        var values = await timeout(bridge.storage.get([SAVE_KEY, STATS_KEY, LS_KEY]), 6000);
        if (Array.isArray(values)) {
          cache.data = parse(values[0]) || {};
          cache.stats = parse(values[1]) || {};
          var ls = parse(values[2]);
          if (ls && typeof ls === 'object') {
            Object.keys(ls).forEach(function (k) {
              safe(function () { if (localStorage.getItem(k) === null && ls[k] != null) lsSet.call(localStorage, k, String(ls[k])); });
            });
          }
        }
      } catch (e) { /* no saved data */ }
      state.ready = true;
      note('bridge_ready:' + safe(function () { return bridge.platform.id; }) + ':' + lang());
      lastSnapshot = snapshot();
      syncPause();
    })();
    return initPromise;
  }
  initBridge();

  // ---------- ads ----------
  var adBusy = false;
  function showAd(kind, callbacks) {
    callbacks = callbacks || {};
    note('ad:' + kind);
    function call(name, arg) { if (typeof callbacks[name] === 'function') safe(function () { callbacks[name](arg); }); }
    initBridge().then(function () {
      var adv = hasBridge() && bridge.advertisement;
      var rewarded = kind === 'rewarded';
      var supported = adv && (rewarded ? adv.isRewardedSupported : adv.isInterstitialSupported);
      if (!supported || adBusy) {
        if (rewarded) call('onError', new Error('Rewarded ad is not available'));
        call('onClose', false);
        return;
      }
      adBusy = true;
      var eventName = rewarded ? bridge.EVENT_NAME.REWARDED_STATE_CHANGED : bridge.EVENT_NAME.INTERSTITIAL_STATE_CHANGED;
      var opened = false, done = false, timer = 0;
      function finish(shown, failed) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        safe(function () { adv.off(eventName, onState); });
        adBusy = false;
        if (state.adOpen) { state.adOpen = false; applyAudio(); }
        if (failed && rewarded) call('onError', new Error('Ad failed'));
        call('onClose', !!shown);
      }
      function arm(ms) { clearTimeout(timer); timer = setTimeout(function () { if (!opened) finish(false, true); }, ms); }
      function onState(s) {
        if (done) return;
        if (s === 'loading') arm(15000);
        else if (s === 'opened') {
          if (opened) return;
          opened = true;
          clearTimeout(timer);
          state.adOpen = true;
          applyAudio();
          call('onOpen');
        } else if (s === 'rewarded') call('onRewarded');
        else if (s === 'closed') finish(true, false);
        else if (s === 'failed') finish(false, true);
      }
      adv.on(eventName, onState);
      arm(5000);
      try {
        var r = rewarded ? adv.showRewarded() : adv.showInterstitial();
        Promise.resolve(r).catch(function () { finish(false, true); });
      } catch (e) { finish(false, true); }
    });
  }

  // ---------- Yandex SDK surface ----------
  function rejectNA() { return Promise.reject(new Error('Not available on this platform')); }
  function pick(obj, keys) {
    if (!Array.isArray(keys)) return JSON.parse(JSON.stringify(obj));
    var out = {};
    keys.forEach(function (k) { if (k in obj) out[k] = obj[k]; });
    return out;
  }
  function deviceType() {
    var t = safe(function () { return bridge.device.type; });
    if (t === 'mobile' || t === 'tablet' || t === 'desktop' || t === 'tv') return t;
    return /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
  }
  function normalizeLang(l) {
    var code = String(l || '').slice(0, 2).toLowerCase();
    return /^[a-z]{2}$/.test(code) ? code : 'en';
  }
  // cached value only: never touches bridge.platform.language again
  function lang() { return language || 'en'; }

  var player = {
    getMode: function () { return 'lite'; },
    isAuthorized: function () { return false; },
    getUniqueID: function () { return String(safe(function () { return bridge.player.id; }) || ''); },
    getName: function () { return ''; },
    getPhoto: function () { return ''; },
    getIDsPerGame: function () { return Promise.resolve([]); },
    getPayingStatus: function () { return 'unknown'; },
    getData: function (keys) { return initBridge().then(function () { return pick(cache.data, keys); }); },
    setData: function (data) {
      cache.data = Object.assign({}, data || {});
      return initBridge().then(function () { return storageSet(SAVE_KEY, JSON.stringify(cache.data)); }).then(function () { return true; });
    },
    getStats: function (keys) { return initBridge().then(function () { return pick(cache.stats, keys); }); },
    setStats: function (stats) {
      cache.stats = Object.assign({}, stats || {});
      return initBridge().then(function () { return storageSet(STATS_KEY, JSON.stringify(cache.stats)); }).then(function () { return true; });
    },
    incrementStats: function (inc) {
      Object.keys(inc || {}).forEach(function (k) { cache.stats[k] = (Number(cache.stats[k]) || 0) + (Number(inc[k]) || 0); });
      return initBridge().then(function () { return storageSet(STATS_KEY, JSON.stringify(cache.stats)); }).then(function () { return pick(cache.stats, Object.keys(inc || {})); });
    }
  };

  var leaderboardsLegacy = {
    setLeaderboardScore: function () { return Promise.resolve(); },
    getLeaderboardEntries: rejectNA,
    getLeaderboardPlayerEntry: rejectNA,
    getLeaderboardDescription: rejectNA
  };

  var gameReadySent = false;
  var ysdk = {
    get environment() {
      return {
        app: { id: '' },
        browser: { lang: lang() },
        i18n: { lang: lang(), tld: 'com' },
        payload: safe(function () { return bridge.platform.payload; }) || null
      };
    },
    get deviceInfo() {
      var t = deviceType();
      return {
        type: t,
        isMobile: function () { return t === 'mobile'; },
        isTablet: function () { return t === 'tablet'; },
        isDesktop: function () { return t === 'desktop'; },
        isTV: function () { return t === 'tv'; }
      };
    },
    EVENTS: {
      HISTORY_BACK: 'HISTORY_BACK',
      ACCOUNT_SELECTION_DIALOG_OPENED: 'ACCOUNT_SELECTION_DIALOG_OPENED',
      ACCOUNT_SELECTION_DIALOG_CLOSED: 'ACCOUNT_SELECTION_DIALOG_CLOSED'
    },
    features: {
      LoadingAPI: {
        ready: function () {
          if (gameReadySent) return;
          gameReadySent = true;
          initBridge().then(function () { note('game_ready'); safe(function () { bridge.platform.sendMessage('game_ready'); }); });
        }
      },
      GameplayAPI: {
        start: function () {
          if (state.gameplay === 'active') return;
          var msg = state.gameplay === 'paused' ? 'level_resumed' : 'level_started';
          state.gameplay = 'active';
          initBridge().then(function () { safe(function () { bridge.platform.sendMessage(msg); }); });
        },
        stop: function () {
          if (state.gameplay !== 'active') return;
          state.gameplay = 'paused';
          initBridge().then(function () { safe(function () { bridge.platform.sendMessage('level_paused'); }); });
        }
      },
      PluginEngineDataReporterAPI: { report: function () {} },
      GamesAPI: { getAllGames: function () { return Promise.resolve({ games: [] }); }, getGameByID: rejectNA }
    },
    adv: {
      showFullscreenAdv: function (opts) { showAd('interstitial', opts && opts.callbacks); },
      showRewardedVideo: function (opts) { showAd('rewarded', opts && opts.callbacks); },
      showBannerAdv: function () { return Promise.resolve({ stickyAdvIsShowing: false, reason: 'UNKNOWN' }); },
      hideBannerAdv: function () { return Promise.resolve({ stickyAdvIsShowing: false }); },
      getBannerAdvStatus: function () { return Promise.resolve({ stickyAdvIsShowing: false, reason: 'UNKNOWN' }); }
    },
    auth: { openAuthDialog: rejectNA },
    openAuthDialog: rejectNA,
    getPlayer: function () { return initBridge().then(function () { return player; }); },
    getLeaderboards: function () { return Promise.resolve(leaderboardsLegacy); },
    leaderboards: {
      setScore: function () { return Promise.resolve(); },
      getEntries: rejectNA,
      getPlayerEntry: rejectNA,
      getDescription: rejectNA
    },
    getPayments: rejectNA,
    payments: { getCatalog: rejectNA, getPurchases: rejectNA, purchase: rejectNA, consumePurchase: rejectNA },
    getFlags: function () { return Promise.resolve({}); },
    isAvailableMethod: function () { return Promise.resolve(false); },
    getStorage: function () { return Promise.resolve(window.localStorage); },
    serverTime: function () { return Date.now(); },
    shortcut: {
      canShowPrompt: function () { return Promise.resolve({ canShow: false }); },
      showPrompt: function () { return Promise.resolve({ outcome: 'rejected' }); }
    },
    feedback: {
      canReview: function () { return Promise.resolve({ value: false, reason: 'UNKNOWN' }); },
      requestReview: function () { return Promise.resolve({ feedbackSent: false }); }
    },
    screen: {
      fullscreen: {
        get status() { return document.fullscreenElement ? 'on' : 'off'; },
        STATUS_ON: 'on',
        STATUS_OFF: 'off',
        request: function () { return Promise.resolve(safe(function () { return document.documentElement.requestFullscreen(); })).catch(function () {}); },
        exit: function () { return Promise.resolve(safe(function () { return document.exitFullscreen(); })).catch(function () {}); }
      }
    },
    clipboard: {
      writeText: function (t) { return Promise.resolve(safe(function () { return navigator.clipboard.writeText(t); })).catch(function () {}); }
    },
    multiplayer: {
      sessions: { init: function () { return Promise.resolve([]); }, commit: function () {}, push: function () {} }
    },
    on: function (name, fn) {
      (handlers[name] = handlers[name] || []).push(fn);
      if (name === 'game_api_pause' && state.paused) later(fn);
      return function () { ysdk.off(name, fn); };
    },
    off: function (name, fn) {
      handlers[name] = (handlers[name] || []).filter(function (h) { return h !== fn; });
    },
    dispatchEvent: function () { return Promise.resolve(); }
  };

  window.YaGames = {
    init: function () { note('YaGames.init'); return initBridge().then(function () { return ysdk; }); }
  };

  // ---------- games that inject the Yandex SDK script themselves ----------
  function isYandexSdkScript(node) {
    if (!node || node.nodeName !== 'SCRIPT') return false;
    var src = node.getAttribute && node.getAttribute('src');
    if (!src) return false;
    return /^(\.?\/)?sdk\.js(\?.*)?$/.test(src) || /yandex\.(ru|com|net)\/games\/sdk/.test(src);
  }
  function fakeLoad(node) {
    note('sdk_script_intercepted');
    initBridge().then(function () {
      later(function () { node.dispatchEvent(new Event('load')); });
    });
    return node;
  }
  function patch(proto, method) {
    var nativeFn = proto[method];
    if (!nativeFn) return;
    proto[method] = function () {
      for (var i = 0; i < arguments.length; i++) {
        if (isYandexSdkScript(arguments[i])) {
          fakeLoad(arguments[i]);
          return method === 'appendChild' || method === 'insertBefore' ? arguments[i] : undefined;
        }
      }
      return nativeFn.apply(this, arguments);
    };
  }
  patch(Node.prototype, 'appendChild');
  patch(Node.prototype, 'insertBefore');
  patch(Element.prototype, 'append');
  patch(Element.prototype, 'prepend');
})();
