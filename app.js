/* Répète — logique pure du lecteur (sans DOM, testable sous Node). */
(function (root) {
  'use strict';

  var DEFAULTS = {
    mine: [],              // identifiants de rôles que je répète
    roleStates: {},        // { ROLE: 'normal' | 'muet' | 'masque' } (surcharge individuelle)
    mode: 'silence',       // pendant mes répliques : 'silence' | 'attente' | 'souffleur'
    cues: false,           // mode « Répliques » : seulement les répliques qui précèdent les miennes
    cueCount: 2,           // 1 à 3
    rate: 1,               // 0,75 à 1,5
    fontSize: 18,
    showDirections: true
  };

  function mergeSettings(saved) {
    var s = {}, k;
    for (k in DEFAULTS) s[k] = DEFAULTS[k];
    saved = saved || {};
    for (k in saved) if (k in DEFAULTS) s[k] = saved[k];
    s.cueCount = Math.min(3, Math.max(1, Math.round(s.cueCount) || 1));
    s.rate = Math.min(1.5, Math.max(0.75, Number(s.rate) || 1));
    return s;
  }

  function isMineRole(roleId, settings) {
    return settings.mine.indexOf(roleId) !== -1;
  }

  /* Un rôle collectif nommé explicitement (« A ET B ») inclut mes rôles s'ils y figurent.
     Un collectif générique (TOUS…) n'est pas « à moi » : on joue une variante à la voix d'un autre rôle. */
  function collectiveIncludesMine(roleId, settings) {
    var parts = String(roleId).split(/_ET_|_&_/);
    if (parts.length < 2) return false;
    return parts.some(function (p) { return settings.mine.indexOf(p) !== -1; });
  }

  function isMineLine(line, settings) {
    if (line.collective) return collectiveIncludesMine(line.role, settings);
    return isMineRole(line.role, settings);
  }

  function roleState(roleId, settings) {
    var st = settings.roleStates[roleId];
    if (st === 'normal' || st === 'muet' || st === 'masque') return st;
    return isMineRole(roleId, settings) ? 'masque' : 'normal';
  }

  /* Première variante dont la voix n'appartient pas à « mes rôles » (6.4 du cahier des charges). */
  function pickVariant(line, settings) {
    var vs = line.variants || [];
    for (var i = 0; i < vs.length; i++) {
      if (settings.mine.indexOf(vs[i].voice_of) === -1) return vs[i];
    }
    return vs[0] || null;
  }

  function audioFor(line, settings) {
    if (line.variants && line.variants.length) {
      var v = pickVariant(line, settings);
      return v ? { file: v.file, duration: v.duration, voice_of: v.voice_of } : null;
    }
    if (line.file) return { file: line.file, duration: line.duration, voice_of: null };
    return null;
  }

  /* Plan de lecture : pour chaque réplique, ce que fait le lecteur.
     kind : 'none' (rien à jouer) | 'skip' (sautée, mode Répliques) | 'play' (audio)
          | 'timed' (silence au rythme d'origine) | 'wait' (attend un appui)            */
  function buildPlan(lines, settings) {
    var n = lines.length, plan = [], i;
    var mine = lines.map(function (l) { return isMineLine(l, settings); });
    var inCueWindow = new Array(n).fill(false);
    if (settings.cues) {
      for (i = 0; i < n; i++) {
        if (!mine[i]) continue;
        for (var k = 1; k <= settings.cueCount && i - k >= 0; k++) {
          if (mine[i - k]) break;
          inCueWindow[i - k] = true;
        }
      }
    }
    for (i = 0; i < n; i++) {
      var l = lines[i], a = audioFor(l, settings);
      var it = { i: i, kind: 'none', mine: mine[i], prompt: false, ms: 0, pauseMs: l.pause_after || 0,
                 audio: a, state: roleState(l.role, settings) };
      if (mine[i] && l.collective && !(l.role in settings.roleStates)) it.state = 'masque';
      var dur = (a ? a.duration : (l.duration || 0)) || 0;
      it.ms = Math.round(dur * 1000);
      if (!a) {
        it.kind = 'none'; it.pauseMs = 0; it.ms = 0;
      } else if (mine[i]) {
        if (it.state === 'normal' && !settings.cues) {
          it.kind = 'play';
        } else if (settings.cues || settings.mode === 'attente' || settings.mode === 'souffleur') {
          it.kind = 'wait'; it.prompt = settings.mode === 'souffleur';
        } else {
          it.kind = 'timed';
        }
      } else if (settings.cues && !inCueWindow[i]) {
        it.kind = 'skip';
      } else if (it.state === 'normal') {
        it.kind = 'play';
      } else {
        it.kind = 'timed';   // rôle muet ou masqué : le temps s'écoule sans son
      }
      plan.push(it);
    }
    return plan;
  }

  /* Index suivant (ou précédent) à visiter, en ignorant les répliques sautées. -1 si aucun. */
  function stepIndex(plan, i, dir) {
    var j = i + dir;
    while (j >= 0 && j < plan.length && plan[j].kind === 'skip') j += dir;
    return j >= 0 && j < plan.length ? j : -1;
  }

  /* Texte masqué : 2-3 premiers mots + points de suspension. */
  function maskText(text, words) {
    words = words || 3;
    var parts = String(text).replace(/\s+/g, ' ').trim().split(' ');
    if (parts.length <= words) return parts.join(' ') + ' …';
    return parts.slice(0, words).join(' ') + ' …';
  }

  /* Segments d'affichage d'une réplique : texte et didascalies (avant / dans / après), dans l'ordre. */
  function displaySegments(line) {
    var text = line.text_display || '';
    var dirs = (line.stage_directions || []).slice().sort(function (a, b) { return a.char_offset - b.char_offset; });
    var segs = [], pos = 0;
    dirs.forEach(function (d) {
      var off = Math.min(Math.max(d.char_offset, 0), text.length);
      if (off > pos) { segs.push({ t: 'text', s: text.slice(pos, off) }); pos = off; }
      segs.push({ t: 'dir', s: d.text, position: d.position });
    });
    if (pos < text.length) segs.push({ t: 'text', s: text.slice(pos) });
    return segs;
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  var core = {
    DEFAULTS: DEFAULTS, mergeSettings: mergeSettings, isMineRole: isMineRole, isMineLine: isMineLine,
    collectiveIncludesMine: collectiveIncludesMine, roleState: roleState, pickVariant: pickVariant,
    audioFor: audioFor, buildPlan: buildPlan, stepIndex: stepIndex, maskText: maskText,
    displaySegments: displaySegments, formatTime: formatTime
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else { root.Repete = root.Repete || {}; root.Repete.core = core; }
})(typeof window !== 'undefined' ? window : globalThis);

/* Répète — stockage local des réglages et de la progression (localStorage, toujours dans un try/catch).
   Le stockage ne sert qu'à des commodités par appareil : l'application fonctionne sans. */
(function (root) {
  'use strict';
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  var store = {
    get: function (key, fallback) {
      return safe(function () {
        var v = root.localStorage.getItem('repete.' + key);
        return v == null ? fallback : JSON.parse(v);
      }, fallback);
    },
    set: function (key, value) {
      safe(function () { root.localStorage.setItem('repete.' + key, JSON.stringify(value)); });
    }
  };
  root.Repete = root.Repete || {};
  root.Repete.store = store;
})(typeof window !== 'undefined' ? window : globalThis);

/* Répète — moteur de lecture (PlaybackEngine) : séquenceur de répliques avec deux éléments <audio>
   en alternance (« ping-pong ») : pendant que l'un joue la réplique n, l'autre précharge la suivante.
   Pauses, silences chronométrés et attentes utilisent l'horloge du séquenceur. */
(function (root) {
  'use strict';
  var core = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.Repete.core;
  var CANCEL = { cancelled: true };
  // WAV silencieux minimal (déverrouillage audio au premier geste, exigé par iOS/Android)
  var SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

  function makeEl() {
    var a = new Audio();
    a.preload = 'auto';
    a.preservesPitch = a.webkitPreservesPitch = a.mozPreservesPitch = true;
    return a;
  }

  function Engine(urlFor) {
    this.urlFor = urlFor;                 // (fichier de la scène) -> URL jouable
    this.slots = [{ el: makeEl(), i: -1, url: '' }, { el: makeEl(), i: -1, url: '' }];
    this.promptEl = makeEl();             // rejouer une réplique pour le souffleur
    this.cb = {};
    this.lines = []; this.plan = []; this.settings = core.mergeSettings({});
    this.i = 0; this.playing = false; this.token = 0;
    this.activeSlot = 0; this.st = null;
    this.loop = null; this.rate = 1;
    this._cancel = null; this._tap = null;
    this.unlocked = false;
  }

  Engine.prototype.on = function (name, fn) { this.cb[name] = fn; return this; };
  Engine.prototype._emit = function (name) {
    var f = this.cb[name];
    if (f) f.apply(null, Array.prototype.slice.call(arguments, 1));
  };

  Engine.prototype.load = function (lines, settings) {
    this.stop();
    this.lines = lines; this.i = 0; this.st = null; this.loop = null;
    this.slots.forEach(function (s) { s.i = -1; s.url = ''; });
    this.setSettings(settings);
    this.i = this._firstIndex(0);
    this._emit('line', this.i, this.plan[this.i]);
  };

  Engine.prototype.setSettings = function (settings) {
    this.settings = settings;
    this.plan = core.buildPlan(this.lines, settings);
    this.setRate(settings.rate);
  };

  Engine.prototype._firstIndex = function (from) {
    var j = from;
    while (j < this.plan.length && this.plan[j].kind === 'skip') j++;
    return j < this.plan.length ? j : Math.max(0, this.plan.length - 1);
  };

  /* À appeler dans un geste utilisateur (écran « Démarrer »). */
  Engine.prototype.unlock = function () {
    if (this.unlocked) return;
    this.unlocked = true;
    var els = this.slots.map(function (s) { return s.el; }).concat([this.promptEl]);
    els.forEach(function (el) {
      try {
        el.src = SILENT;
        var p = el.play();
        if (p && p.then) p.then(function () { el.pause(); }).catch(function () {});
      } catch (e) { /* ignoré */ }
    });
    this.slots.forEach(function (s) { s.i = -1; s.url = ''; });
  };

  Engine.prototype.setRate = function (r) {
    this.rate = r;
    this.slots.forEach(function (s) { s.el.playbackRate = r; });
    this.promptEl.playbackRate = r;
  };

  Engine.prototype.setLoop = function (a, b) {
    this.loop = (a == null || b == null) ? null : { a: Math.min(a, b), b: Math.max(a, b) };
    this._emit('loop', this.loop);
  };

  // ---------------------------------------------------------------- préparation audio
  Engine.prototype._prepare = function (i, avoidSlot) {
    var it = this.plan[i];
    if (!it || it.kind !== 'play' || !it.audio) return null;
    var url = this.urlFor(it.audio.file);
    var s, k;
    for (k = 0; k < 2; k++) {
      s = this.slots[k];
      if (s.i === i && s.url === url) return k;
    }
    k = (avoidSlot === 0) ? 1 : (avoidSlot === 1 ? 0 : 1 - this.activeSlot);
    s = this.slots[k];
    s.i = i; s.url = url;
    s.el.src = url;
    s.el.playbackRate = this.rate;
    s.el.currentTime = 0;
    try { s.el.load(); } catch (e) { /* ignoré */ }
    return k;
  };

  Engine.prototype._preloadNext = function (from) {
    for (var j = from + 1; j < this.plan.length; j++) {
      if (this.plan[j].kind === 'play') { this._prepare(j, this.activeSlot); return; }
      if (this.plan[j].kind === 'wait') return;
    }
  };

  // ---------------------------------------------------------------- étapes d'une réplique
  Engine.prototype._steps = function (it) {
    var pause = { t: 'sleep', ms: it.pauseMs / this.rate };
    switch (it.kind) {
      case 'play': return [{ t: 'audio' }, pause];
      case 'timed': return [{ t: 'sleep', ms: it.ms / this.rate }, pause];
      case 'wait': return [{ t: 'wait' }];
      default: return [];
    }
  };

  Engine.prototype._sleep = function (tok, ms) {
    var self = this, start = performance.now();
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { self._cancel = null; res(); }, Math.max(0, ms));
      self._cancel = function () {
        clearTimeout(t);
        if (self.st) self.st.left = Math.max(0, ms - (performance.now() - start));
        rej(CANCEL);
      };
    });
  };

  Engine.prototype._playAudio = function (tok, it) {
    var self = this;
    var k = this._prepare(this.i, null);
    if (k === null) return Promise.resolve();
    this.activeSlot = k;
    var el = this.slots[k].el;
    el.playbackRate = this.rate;
    return new Promise(function (res, rej) {
      el.onended = function () { self._cancel = null; res(); };
      el.onerror = function () { self._cancel = null; rej(new Error('Lecture audio impossible')); };
      self._cancel = function () { el.pause(); rej(CANCEL); };
      var p = el.play();
      self._preloadNext(self.i);
      if (p && p.catch) p.catch(function (e) { self._cancel = null; rej(e); });
    });
  };

  Engine.prototype._waitTap = function () {
    var self = this;
    return new Promise(function (res, rej) {
      self._tap = function () { self._tap = null; self._cancel = null; res(); };
      self._cancel = function () { self._tap = null; rej(CANCEL); };
    });
  };

  Engine.prototype._advance = function () {
    if (this.loop && this.i === this.loop.b) return this.loop.a;
    return core.stepIndex(this.plan, this.i, 1);
  };

  Engine.prototype._run = function () {
    var self = this, tok = ++this.token;
    var go = async function () {
      while (self.playing && tok === self.token) {
        var it = self.plan[self.i];
        if (!it) break;
        if (it.kind === 'skip') {
          var nx0 = self._advance();
          if (nx0 < 0) break;
          self.i = nx0; self.st = null; continue;
        }
        var steps = self._steps(it);
        if (!self.st || self.st.i !== self.i) {
          self.st = { i: self.i, step: 0, left: null };
          self._emit('line', self.i, it);
          if (it.kind === 'play') self._prepare(self.i, null);
        }
        while (self.st.step < steps.length) {
          var step = steps[self.st.step];
          if (step.t === 'audio') {
            if (self.st.resumed) { /* reprise au point d'arrêt : currentTime est conservé */ }
            await self._playAudio(tok, it);
          } else if (step.t === 'sleep') {
            var ms = self.st.left != null ? self.st.left : step.ms;
            self.st.left = ms;
            await self._sleep(tok, ms);
            self.st.left = null;
          } else if (step.t === 'wait') {
            self._emit('wait', self.i, it, true);
            try { await self._waitTap(); } finally { self._emit('wait', self.i, it, false); }
          }
          self.st.step++;
          self.st.left = null;
        }
        var nx = self._advance();
        if (nx < 0) break;
        self.i = nx; self.st = null;
      }
      if (tok === self.token && self.playing) { self.playing = false; self._emit('state', false); self._emit('end'); }
    };
    go().catch(function (e) {
      if (e === CANCEL) return;
      if (tok !== self.token) return;
      self.playing = false;
      self._emit('state', false);
      self._emit('error', e && e.name === 'NotAllowedError'
        ? 'Le navigateur a bloqué le son : touche Lecture pour reprendre.'
        : 'Erreur de lecture : ' + (e && e.message ? e.message : e));
    });
  };

  // ---------------------------------------------------------------- commandes
  Engine.prototype.play = function () {
    if (this.playing) return;
    this.playing = true;
    this._emit('state', true);
    this._run();
  };

  Engine.prototype.pause = function () {
    if (!this.playing) return;
    this.playing = false;
    this.token++;
    if (this._cancel) { var c = this._cancel; this._cancel = null; c(); }
    this._emit('state', false);
  };

  Engine.prototype.stop = function () {
    this.playing = false; this.token++;
    if (this._cancel) { var c = this._cancel; this._cancel = null; try { c(); } catch (e) { /* ignoré */ } }
    this.slots.forEach(function (s) { s.el.pause(); });
    this.promptEl.pause();
    this.st = null;
  };

  Engine.prototype.toggle = function () { this.playing ? this.pause() : this.play(); };

  Engine.prototype._jump = function (j) {
    var wasPlaying = this.playing;
    if (wasPlaying) {
      this.token++;
      if (this._cancel) { var c = this._cancel; this._cancel = null; c(); }
    }
    this.slots.forEach(function (s) { s.el.pause(); });
    this.promptEl.pause();
    this.i = j; this.st = null;
    this._emit('line', this.i, this.plan[this.i]);
    if (wasPlaying) this._run();
  };

  Engine.prototype.seek = function (j) {
    if (j < 0 || j >= this.plan.length) return;
    this._jump(j);
  };

  /* « Suivant » : si le lecteur attend, on continue ; sinon on saute à la réplique suivante. */
  Engine.prototype.next = function () {
    if (this._tap) { this._tap(); return; }
    var j = core.stepIndex(this.plan, this.i, 1);
    if (j >= 0) this._jump(j);
  };

  Engine.prototype.prev = function () {
    var j = core.stepIndex(this.plan, this.i, -1);
    if (j >= 0) this._jump(j);
  };

  /* Souffleur : rejoue une fois la réplique courante (sans changer l'état de la séquence). */
  Engine.prototype.replay = function (i) {
    var it = this.plan[i == null ? this.i : i];
    if (!it || !it.audio) return;
    var el = this.promptEl;
    el.src = this.urlFor(it.audio.file);
    el.playbackRate = this.rate;
    var p = el.play();
    if (p && p.catch) p.catch(function () {});
  };

  var api = { Engine: Engine, CANCEL: CANCEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Repete = root.Repete || {}; root.Repete.engine = api; }
})(typeof window !== 'undefined' ? window : globalThis);

/* Répète — interface du lecteur : texte qui défile, surlignage par réplique, rôles, modes, réglages. */
(function (root) {
  'use strict';
  var R = root.Repete, core = R.core, store = R.store;
  var $ = function (sel, el) { return (el || document).querySelector(sel); };

  function h(tag, attrs, kids) {
    var el = document.createElement(tag), k;
    for (k in (attrs || {})) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  function hexToRgba(hex, a) {
    var n = parseInt(hex.replace('#', ''), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  var RATES = [0.75, 0.9, 1, 1.15, 1.3, 1.5];
  var MODES = [['silence', 'Silence chronométré', 'La durée d’origine de la réplique s’écoule en silence.'],
               ['attente', 'Attente', 'Pause jusqu’à ton appui sur « Suivant ».'],
               ['souffleur', 'Souffleur', 'Comme l’attente, avec un bouton pour révéler et rejouer la réplique.']];

  function App(data, engineFactory) {
    this.data = data;                         // { manifest, scenes: {id: scene}, audioUrl(sceneId, file) }
    this.packId = data.manifest.pack_id;
    this.sceneId = null;
    this.settingsKey = 'settings.' + this.packId;
    this.settings = core.mergeSettings(store.get(this.settingsKey, {}));
    this.revealed = {};
    this.review = store.get('review.' + this.packId, {});
    this.lineEls = [];
    this.waiting = false;
    this.abState = 0; this.abA = null;
    this.wakeLock = null;
    this.engineFactory = engineFactory;
    this.roles = {};
    data.manifest.roles.forEach(function (r) { this.roles[r.id] = r; }, this);
  }

  App.prototype.mount = function (rootEl) {
    var self = this;
    this.root = rootEl;
    rootEl.innerHTML = '';
    this.header = h('header', { class: 'bar' }, [
      this.data.onBack ? h('button', { class: 'icon', 'aria-label': 'Retour à la bibliothèque', onclick: function () { self.exit(); }, text: '‹' }) : null,
      h('div', { class: 'titles' }, [h('div', { class: 'play', text: this.data.manifest.play.title }),
                                      this.sceneSelect = h('select', { 'aria-label': 'Scène' })]),
      h('button', { class: 'icon', 'aria-label': 'Réglages', onclick: function () { self.openSettings(); }, text: '⚙' })
    ]);
    this.text = h('main', { id: 'text', tabindex: '-1' });
    this.banner = h('div', { class: 'banner', hidden: true });
    this.controls = this.buildControls();
    this.start = h('div', { class: 'start' }, [
      h('div', { class: 'card' }, [
        h('h1', { text: this.data.manifest.play.title }),
        this.startScene = h('p', { class: 'sub' }),
        h('p', { text: 'Choisis tes rôles dans les réglages, puis démarre. Le son reste sur ton appareil, rien n’est envoyé.' }),
        h('button', { class: 'primary big', id: 'start-btn', text: 'Démarrer', onclick: function () { self.begin(); } }),
        h('button', { class: 'link', text: 'Réglages et rôles', onclick: function () { self.openSettings(); } })
      ])]);
    rootEl.appendChild(this.header);
    rootEl.appendChild(this.banner);
    rootEl.appendChild(this.text);
    rootEl.appendChild(this.controls);
    rootEl.appendChild(this.start);

    this.data.manifest.scenes.forEach(function (s) {
      self.sceneSelect.appendChild(h('option', { value: s.id, text: s.title }));
    });
    this.sceneSelect.addEventListener('change', function () { self.openScene(self.sceneSelect.value, true); });
    this.engine = this.engineFactory(function (file) { return self.data.audioUrl(self.sceneId, file); });
    this.engine
      .on('line', function (i) { self.onLine(i); })
      .on('wait', function (i, it, on) { self.onWait(i, it, on); })
      .on('state', function (p) { self.onState(p); })
      .on('end', function () { self.showBanner('Fin de la scène.'); })
      .on('error', function (m) { self.showBanner(m, true); })
      .on('loop', function (l) { self.onLoop(l); });
    this.applyFont();
    this.openScene(this.data.startScene || this.data.manifest.scenes[0].id, false);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && self.engine.playing) self.requestWake();
    });
    this.bindKeys();
  };

  App.prototype.buildControls = function () {
    var self = this;
    this.progress = h('input', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Position (réplique)',
                                 oninput: function () { self.engine.seek(parseInt(self.progress.value, 10)); } });
    this.posLabel = h('span', { class: 'pos' });
    this.btnPlay = h('button', { class: 'primary round', 'aria-label': 'Lecture', onclick: function () { self.toggle(); }, text: '▶' });
    this.btnNext = h('button', { class: 'next', onclick: function () { self.engine.next(); }, text: 'Suivant ▶', hidden: true });
    this.btnPrompt = h('button', { class: 'prompt', onclick: function () { self.prompt(); }, text: 'Souffler', hidden: true });
    this.btnAB = h('button', { class: 'chip', onclick: function () { self.cycleAB(); }, text: 'A-B', 'aria-label': 'Boucle A-B' });
    this.btnRate = h('button', { class: 'chip', onclick: function () { self.cycleRate(); } });
    this.btnCues = h('button', { class: 'chip', onclick: function () { self.toggleCues(); }, text: 'Répliques' });
    this.updateRateLabel();
    return h('footer', { class: 'controls' }, [
      h('div', { class: 'wait-row' }, [this.btnPrompt, this.btnNext]),
      h('div', { class: 'prog-row' }, [this.progress, this.posLabel]),
      h('div', { class: 'btn-row' }, [
        this.btnCues, this.btnAB,
        h('button', { class: 'round', 'aria-label': 'Réplique précédente', onclick: function () { self.engine.prev(); }, text: '⏮' }),
        this.btnPlay,
        h('button', { class: 'round', 'aria-label': 'Réplique suivante', onclick: function () { self.engine.next(); }, text: '⏭' }),
        this.btnRate
      ])]);
  };

  // ------------------------------------------------------------------ scène
  App.prototype.exit = function () {
    this.engine.stop();
    this.releaseWake();
    if (this.data.onBack) this.data.onBack();
  };

  /* Charge la scène ; la cible PWA prépare d'abord ses fichiers audio (data.prepare), l'artefact non. */
  App.prototype.openScene = function (id, keepPlaying) {
    var self = this;
    if (!this.data.scenes[id]) return;
    this.engine.stop();
    this.onState(false);
    if (this.data.prepare) {
      this.showBanner('Chargement de la scène…');
      this.data.prepare(id).then(function () { self.hideBanner(); self._openScene(id); })
        .catch(function (e) { self.showBanner('Scène illisible : ' + (e && e.message ? e.message : e), true); });
    } else this._openScene(id);
  };

  App.prototype._openScene = function (id) {
    var scene = this.data.scenes[id];
    this.sceneId = id;
    this.sceneSelect.value = id;
    this.startScene.textContent = scene.scene.title;
    this.revealed = {};
    this.abState = 0; this.abA = null;
    this.engine.load(scene.lines, this.settings);
    this.renderLines();
    this.progress.max = Math.max(0, scene.lines.length - 1);
    this.btnAB.textContent = 'A-B';
    this.btnAB.classList.remove('on');
    this.updateStates();
    this.onLine(this.engine.i);
    this.setMediaMeta();
  };

  App.prototype.lines = function () { return this.data.scenes[this.sceneId].lines; };

  App.prototype.renderLines = function () {
    var self = this;
    this.text.innerHTML = '';
    this.lineEls = this.lines().map(function (ln, i) {
      var role = self.roles[ln.role] || { label: ln.role, color: '#888' };
      var el = h('article', { class: 'line', 'data-i': i, style: '--c:' + role.color + ';--ct:' + hexToRgba(role.color, 0.16),
                              onclick: function (ev) { if (!ev.target.closest('button')) self.engine.seek(i); } });
      el.appendChild(h('div', { class: 'who' }, [
        h('span', { class: 'name', text: role.label }),
        h('span', { class: 'tags' }),
        h('span', { class: 'acts' }, [
          h('button', { class: 'mini eye', 'aria-label': 'Afficher ou masquer le texte', onclick: function () { self.reveal(i); }, text: '👁' }),
          h('button', { class: 'mini star', 'aria-label': 'À revoir', onclick: function () { self.toggleReview(ln.id); }, text: '☆' })
        ])
      ]));
      el.appendChild(h('div', { class: 'body' }));
      self.text.appendChild(el);
      self.fillBody(i);
      return el;
    });
  };

  App.prototype.fillBody = function (i) {
    var ln = this.lines()[i], el = this.lineEls[i] || this.text.children[i];
    var body = $('.body', el), it = this.engine.plan[i];
    var hidden = it && it.mine !== undefined && this.isMasked(i);
    body.innerHTML = '';
    if (hidden) {
      body.appendChild(h('span', { class: 'masked-text', text: core.maskText(ln.text_display, 3) }));
      return;
    }
    core.displaySegments(ln).forEach(function (seg) {
      if (seg.t === 'dir') body.appendChild(h('span', { class: 'dir', text: seg.s + ' ' }));
      else body.appendChild(document.createTextNode(seg.s));
    });
  };

  App.prototype.isMasked = function (i) {
    var ln = this.lines()[i], it = this.engine.plan[i];
    if (!it) return false;
    var state = it.state;
    return state === 'masque' && !this.revealed[i];
  };

  App.prototype.updateStates = function () {
    var self = this, plan = this.engine.plan;
    this.lineEls.forEach(function (el, i) {
      var it = plan[i], ln = self.lines()[i];
      el.classList.toggle('mine', !!it.mine);
      el.classList.toggle('muet', it.state === 'muet');
      el.classList.toggle('masque', it.state === 'masque');
      el.classList.toggle('skipped', it.kind === 'skip');
      el.classList.toggle('nosound', it.kind === 'none');
      var tags = $('.tags', el);
      tags.textContent = '';
      if (it.mine) tags.appendChild(h('span', { class: 'tag', text: 'à toi' }));
      if (it.state === 'muet') tags.appendChild(h('span', { class: 'tag', text: 'muet' }));
      if (ln.qc === 'a_ecouter') tags.appendChild(h('span', { class: 'tag warn', text: 'à écouter' }));
      var eye = $('.eye', el);
      eye.hidden = it.state !== 'masque';
      $('.star', el).textContent = self.review[ln.id] ? '★' : '☆';
      self.fillBody(i);
    });
    this.text.classList.toggle('no-dir', !this.settings.showDirections);
    this.btnCues.classList.toggle('on', this.settings.cues);
  };

  // ------------------------------------------------------------------ événements du moteur
  App.prototype.onLine = function (i) {
    var self = this;
    this.lineEls.forEach(function (el, k) { el.classList.toggle('current', k === i); });
    this.progress.value = i;
    var n = this.lines().length;
    this.posLabel.textContent = (i + 1) + ' / ' + n;
    var el = this.lineEls[i];
    if (el && el.scrollIntoView) {
      var reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
    this.hideBanner();
  };

  App.prototype.onWait = function (i, it, on) {
    this.waiting = on;
    this.btnNext.hidden = !on;
    this.btnPrompt.hidden = !(on && it.prompt);
    this.controls.classList.toggle('waiting', on);
    if (on) { var el = this.lineEls[i]; if (el) el.classList.add('waiting'); }
    else this.lineEls.forEach(function (e) { e.classList.remove('waiting'); });
  };

  App.prototype.onState = function (playing) {
    this.btnPlay.textContent = playing ? '⏸' : '▶';
    this.btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
    if (playing) this.requestWake(); else this.releaseWake();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  };

  App.prototype.onLoop = function (l) {
    this.lineEls.forEach(function (el, k) { el.classList.toggle('inloop', !!l && k >= l.a && k <= l.b); });
  };

  // ------------------------------------------------------------------ commandes
  App.prototype.begin = function () {
    this.engine.unlock();
    this.start.hidden = true;
    this.engine.play();
  };

  App.prototype.toggle = function () {
    if (!this.engine.unlocked) { this.engine.unlock(); this.start.hidden = true; }
    if (!this.engine.playing && this.engine.i >= this.lines().length - 1 && this.waiting === false
        && this.banner.textContent === 'Fin de la scène.') this.engine.seek(0);
    this.engine.toggle();
  };

  App.prototype.prompt = function () {
    var i = this.engine.i;
    this.revealed[i] = true;
    this.fillBody(i);
    this.engine.replay(i);
  };

  App.prototype.reveal = function (i) {
    this.revealed[i] = !this.revealed[i];
    this.fillBody(i);
    var eye = $('.eye', this.lineEls[i]);
    eye.classList.toggle('on', !!this.revealed[i]);
  };

  App.prototype.toggleReview = function (lineId) {
    if (this.review[lineId]) delete this.review[lineId]; else this.review[lineId] = true;
    store.set('review.' + this.packId, this.review);
    this.updateStates();
  };

  App.prototype.cycleAB = function () {
    var i = this.engine.i;
    if (this.abState === 0) { this.abA = i; this.abState = 1; this.btnAB.textContent = 'A ' + (i + 1) + '…'; this.btnAB.classList.add('on'); }
    else if (this.abState === 1) {
      this.engine.setLoop(this.abA, i); this.abState = 2;
      this.btnAB.textContent = 'A-B ' + (Math.min(this.abA, i) + 1) + '–' + (Math.max(this.abA, i) + 1);
    } else { this.engine.setLoop(null, null); this.abState = 0; this.btnAB.textContent = 'A-B'; this.btnAB.classList.remove('on'); }
  };

  App.prototype.cycleRate = function () {
    var k = RATES.indexOf(this.settings.rate);
    this.settings.rate = RATES[(k + 1) % RATES.length];
    this.save();
    this.engine.setRate(this.settings.rate);
    this.updateRateLabel();
  };
  App.prototype.updateRateLabel = function () {
    this.btnRate.textContent = String(this.settings.rate).replace('.', ',') + '×';
    this.btnRate.setAttribute('aria-label', 'Vitesse');
  };

  App.prototype.toggleCues = function () {
    this.settings.cues = !this.settings.cues;
    this.applySettings();
  };

  App.prototype.save = function () { store.set(this.settingsKey, this.settings); };

  App.prototype.applySettings = function () {
    this.save();
    this.engine.setSettings(this.settings);
    if (!this.engine.playing && this.engine.plan[this.engine.i] && this.engine.plan[this.engine.i].kind === 'skip') {
      var j = core.stepIndex(this.engine.plan, this.engine.i, 1);
      if (j >= 0) this.engine.i = j;
    }
    this.applyFont();
    this.updateRateLabel();
    this.updateStates();
    this.onLine(this.engine.i);
  };

  App.prototype.applyFont = function () {
    document.documentElement.style.setProperty('--fs', this.settings.fontSize + 'px');
  };

  // ------------------------------------------------------------------ bannière, écran verrouillé, clavier
  App.prototype.showBanner = function (msg, isError) {
    this.banner.textContent = msg; this.banner.hidden = false;
    this.banner.classList.toggle('error', !!isError);
  };
  App.prototype.hideBanner = function () { if (this.banner.textContent !== 'Fin de la scène.' || this.engine.playing) this.banner.hidden = true; };

  App.prototype.requestWake = function () {
    var self = this;
    try {
      if (navigator.wakeLock && !this.wakeLock) {
        navigator.wakeLock.request('screen').then(function (l) {
          self.wakeLock = l;
          l.addEventListener('release', function () { self.wakeLock = null; });
        }).catch(function () {});
      }
    } catch (e) { /* repli silencieux */ }
  };
  App.prototype.releaseWake = function () {
    try { if (this.wakeLock) { this.wakeLock.release(); this.wakeLock = null; } } catch (e) { /* ignoré */ }
  };

  App.prototype.setMediaMeta = function () {
    var self = this;
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: this.data.scenes[this.sceneId].scene.title,
                                                           artist: this.data.manifest.play.title, album: 'Répète' });
      navigator.mediaSession.setActionHandler('play', function () { self.engine.play(); });
      navigator.mediaSession.setActionHandler('pause', function () { self.engine.pause(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { self.engine.prev(); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { self.engine.next(); });
    } catch (e) { /* non pris en charge */ }
  };

  App.prototype.bindKeys = function () {
    var self = this;
    document.addEventListener('keydown', function (ev) {
      if (ev.target.closest && ev.target.closest('input,select,textarea,[role=dialog]')) return;
      if (ev.key === ' ') { ev.preventDefault(); self.toggle(); }
      else if (ev.key === 'ArrowRight') self.engine.next();
      else if (ev.key === 'ArrowLeft') self.engine.prev();
    });
  };

  // ------------------------------------------------------------------ réglages
  App.prototype.openSettings = function () {
    var self = this, s = this.settings;
    var close = function () { sheet.remove(); self.applySettings(); };
    var sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Réglages' });
    var panel = h('div', { class: 'panel' });
    sheet.appendChild(panel);
    panel.appendChild(h('div', { class: 'ph' }, [h('h2', { text: 'Réglages' }),
      h('button', { class: 'primary', text: 'Terminé', onclick: close })]));

    // Mes rôles
    panel.appendChild(h('h3', { text: 'Mes rôles' }));
    panel.appendChild(h('p', { class: 'hint', text: 'Ces rôles ne sont pas lus : leur texte est masqué (appui sur l’œil pour le révéler).' }));
    var chips = h('div', { class: 'chips' });
    var rows = h('div', { class: 'rolerows' });
    var roleList = this.data.manifest.roles.filter(function (r) { return !r.collective; });
    var redraw = function () {
      chips.innerHTML = ''; rows.innerHTML = '';
      roleList.forEach(function (r) {
        var on = s.mine.indexOf(r.id) !== -1;
        chips.appendChild(h('button', { class: 'chip role' + (on ? ' on' : ''), style: '--c:' + r.color, 'aria-pressed': on ? 'true' : 'false',
          onclick: function () {
            if (on) s.mine = s.mine.filter(function (x) { return x !== r.id; }); else s.mine = s.mine.concat([r.id]);
            delete s.roleStates[r.id]; redraw();
          } }, [r.label]));
        var st = core.roleState(r.id, s);
        var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'État de ' + r.label });
        [['normal', 'Normal'], ['muet', 'Muet'], ['masque', 'Masqué']].forEach(function (o) {
          seg.appendChild(h('button', { class: 'segbtn' + (st === o[0] ? ' on' : ''), 'aria-pressed': st === o[0] ? 'true' : 'false',
            onclick: function () { s.roleStates[r.id] = o[0]; redraw(); } }, [o[1]]));
        });
        rows.appendChild(h('div', { class: 'rolerow' }, [h('span', { class: 'dot', style: 'background:' + r.color }), h('span', { class: 'rn', text: r.label }), seg]));
      });
    };
    redraw();
    panel.appendChild(chips);
    panel.appendChild(h('h3', { text: 'État de chaque rôle' }));
    panel.appendChild(h('p', { class: 'hint', text: 'Normal : son + texte. Muet : son coupé, texte visible. Masqué : son coupé, texte caché.' }));
    panel.appendChild(rows);

    // Mode pendant mes répliques
    panel.appendChild(h('h3', { text: 'Pendant mes répliques' }));
    var modes = h('div', { class: 'modes' });
    MODES.forEach(function (m) {
      var id = 'mode-' + m[0];
      var input = h('input', { type: 'radio', name: 'mode', id: id, checked: s.mode === m[0],
                               onchange: function () { s.mode = m[0]; } });
      modes.appendChild(h('label', { class: 'opt', for: id }, [input, h('span', {}, [h('b', { text: m[1] }), h('small', { text: m[2] })])]));
    });
    panel.appendChild(modes);

    // Mode Répliques
    panel.appendChild(h('h3', { text: 'Mode « Répliques »' }));
    panel.appendChild(h('label', { class: 'opt' }, [
      h('input', { type: 'checkbox', checked: s.cues, onchange: function (e) { s.cues = e.target.checked; } }),
      h('span', {}, [h('b', { text: 'Ne jouer que les répliques avant les miennes' }),
                     h('small', { text: 'Puis attendre ton appui, pour travailler les enchaînements.' })])]));
    var cc = h('select', { 'aria-label': 'Nombre de répliques', onchange: function (e) { s.cueCount = parseInt(e.target.value, 10); } });
    [1, 2, 3].forEach(function (n) { cc.appendChild(h('option', { value: n, selected: s.cueCount === n, text: n + (n > 1 ? ' répliques précédentes' : ' réplique précédente') })); });
    panel.appendChild(cc);

    // Affichage
    panel.appendChild(h('h3', { text: 'Affichage' }));
    panel.appendChild(h('label', { class: 'range' }, [h('span', { text: 'Taille du texte' }),
      h('input', { type: 'range', min: 14, max: 30, value: s.fontSize, oninput: function (e) { s.fontSize = parseInt(e.target.value, 10); self.applyFont(); } })]));
    panel.appendChild(h('label', { class: 'opt' }, [
      h('input', { type: 'checkbox', checked: s.showDirections, onchange: function (e) { s.showDirections = e.target.checked; } }),
      h('span', {}, [h('b', { text: 'Afficher les didascalies' }), h('small', { text: 'En gris italique, jamais lues.' })])]));
    panel.appendChild(h('button', { class: 'link', text: 'Réinitialiser les réglages', onclick: function () {
      self.settings = core.mergeSettings({}); sheet.remove(); self.applySettings(); self.openSettings(); } }));
    this.root.appendChild(sheet);
    var btn = $('.primary', panel); if (btn) btn.focus();
  };

  R.ui = { App: App };
})(typeof window !== 'undefined' ? window : globalThis);

/* Répète — lecture d'un pack .theatrepack (ZIP, entrées « stored »). Aucune dépendance : on lit l'annuaire
   central du ZIP et on découpe le fichier (Blob.slice) sans le charger entièrement en mémoire. */
(function (root) {
  'use strict';
  var td = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null;

  function u16(v, o) { return v.getUint16(o, true); }
  function u32(v, o) { return v.getUint32(o, true); }

  function readBytes(blob, start, end) {
    return blob.slice(start, end).arrayBuffer();
  }

  async function inflateRaw(buf) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Pack compressé : ce navigateur ne sait pas le décompresser. Demande un pack « sans compression ».');
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([buf]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }

  /* Retourne { names, entry(name) -> {method, csize, usize, start}, readBuffer(name), readText(name), readBlob(name, type) } */
  async function openZip(blob) {
    var size = blob.size;
    if (size < 22) throw new Error('Fichier trop petit : ce n’est pas un pack Répète.');
    var tailLen = Math.min(size, 65557);
    var tail = new DataView(await readBytes(blob, size - tailLen, size));
    var eocd = -1, i;
    for (i = tailLen - 22; i >= 0; i--) { if (u32(tail, i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('Ce fichier n’est pas une archive valide (pack Répète attendu).');
    var count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
    if (cdOff === 0xffffffff || count === 0xffff) throw new Error('Archive trop grande (ZIP64 non pris en charge).');
    var cd = new DataView(await readBytes(blob, cdOff, cdOff + cdSize));
    var entries = {}, p = 0;
    for (i = 0; i < count; i++) {
      if (u32(cd, p) !== 0x02014b50) throw new Error('Annuaire de l’archive corrompu.');
      var method = u16(cd, p + 10), csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      var nlen = u16(cd, p + 28), elen = u16(cd, p + 30), clen = u16(cd, p + 32), lho = u32(cd, p + 42);
      var name = td.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
      entries[name] = { method: method, csize: csize, usize: usize, lho: lho };
      p += 46 + nlen + elen + clen;
    }
    async function dataStart(e) {
      if (e.start != null) return e.start;
      var h = new DataView(await readBytes(blob, e.lho, e.lho + 30));
      if (u32(h, 0) !== 0x04034b50) throw new Error('En-tête d’entrée corrompu.');
      e.start = e.lho + 30 + u16(h, 26) + u16(h, 28);
      return e.start;
    }
    async function readBuffer(name) {
      var e = entries[name];
      if (!e) throw new Error('Fichier absent du pack : ' + name);
      var s = await dataStart(e);
      var buf = await readBytes(blob, s, s + e.csize);
      if (e.method === 0) return buf;
      if (e.method === 8) return inflateRaw(buf);
      throw new Error('Méthode de compression non prise en charge dans le pack.');
    }
    return {
      names: Object.keys(entries), has: function (n) { return !!entries[n]; },
      size: function (n) { return entries[n] ? entries[n].usize : 0; },
      readBuffer: readBuffer,
      readText: async function (n) { return td.decode(await readBuffer(n)); },
      readBlob: async function (n, type) { return new Blob([await readBuffer(n)], { type: type || 'application/octet-stream' }); }
    };
  }

  function sceneTag(id) { return String(id).replace(/\./g, '_'); }

  /* Lit et valide un pack : { manifest, scenes: {id: scene.json}, zip } */
  async function readPack(blob) {
    var zip = await openZip(blob);
    if (!zip.has('manifest.json')) throw new Error('manifest.json absent : ce fichier n’est pas un pack Répète.');
    var manifest = JSON.parse(await zip.readText('manifest.json'));
    if (manifest.schema_version !== 1) throw new Error('Version de pack non prise en charge (' + manifest.schema_version + ').');
    var scenes = {};
    for (var k = 0; k < manifest.scenes.length; k++) {
      var s = manifest.scenes[k], path = 'scenes/' + sceneTag(s.id) + '/scene.json';
      if (!zip.has(path)) throw new Error('Scène ' + s.id + ' absente du pack.');
      scenes[s.id] = JSON.parse(await zip.readText(path));
    }
    return { manifest: manifest, scenes: scenes, zip: zip };
  }

  /* Fichiers audio d'une scène (chemins relatifs à la scène) : répliques, variantes, MP3 complet. */
  function sceneFiles(scene) {
    var f = {};
    scene.lines.forEach(function (l) {
      if (l.file) f[l.file] = 1;
      (l.variants || []).forEach(function (v) { f[v.file] = 1; });
    });
    if (scene.scene && scene.scene.full_audio) f[scene.scene.full_audio] = 1;
    return Object.keys(f);
  }

  var api = { openZip: openZip, readPack: readPack, sceneFiles: sceneFiles, sceneTag: sceneTag };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Repete = root.Repete || {}; root.Repete.pack = api; }
})(typeof window !== 'undefined' ? window : globalThis);

/* Répète — bibliothèque locale (IndexedDB) : pièces, scènes et fichiers audio importés depuis des packs.
   Le fichier pack reste la copie de référence : si le système efface ces données, un réimport suffit. */
(function (root) {
  'use strict';
  var NAME = 'repete', VERSION = 1;

  function open(idb) {
    idb = idb || root.indexedDB;
    return new Promise(function (res, rej) {
      var r = idb.open(NAME, VERSION);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs', { keyPath: 'pack_id' });
        if (!db.objectStoreNames.contains('scenes')) db.createObjectStore('scenes', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('Stockage local indisponible')); };
    });
  }

  function tx(db, stores, mode, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction(stores, mode), out;
      t.oncomplete = function () { res(out); };
      t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error || new Error('Écriture annulée (espace insuffisant ?)')); };
      out = fn(t);
    });
  }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  function Library(db) { this.db = db; }

  Library.open = function (idb) { return open(idb).then(function (db) { return new Library(db); }); };

  Library.prototype.listPacks = function () {
    var db = this.db;
    return tx(db, ['packs'], 'readonly', function (t) { return req(t.objectStore('packs').getAll()); }).then(function (r) { return r; });
  };

  Library.prototype.listScenes = function (packId) {
    var db = this.db;
    return tx(db, ['scenes'], 'readonly', function (t) { return req(t.objectStore('scenes').getAll()); })
      .then(function (all) { return all.filter(function (s) { return s.pack_id === packId; }); });
  };

  Library.prototype.getScene = function (packId, sid) {
    var db = this.db;
    return tx(db, ['scenes'], 'readonly', function (t) { return req(t.objectStore('scenes').get(packId + '/' + sid)); });
  };

  Library.prototype.getPack = function (packId) {
    var db = this.db;
    return tx(db, ['packs'], 'readonly', function (t) { return req(t.objectStore('packs').get(packId)); });
  };

  /* Enregistre une scène : métadonnées + fichiers audio (Map chemin -> Blob) dans une même transaction. */
  Library.prototype.putScene = function (packId, sid, record, audio) {
    var db = this.db;
    return tx(db, ['scenes', 'audio'], 'readwrite', function (t) {
      var sc = t.objectStore('scenes'), au = t.objectStore('audio');
      sc.put(Object.assign({ key: packId + '/' + sid, pack_id: packId, id: sid }, record));
      audio.forEach(function (blob, path) { au.put(blob, packId + '/' + sid + '/' + path); });
    });
  };

  Library.prototype.putPack = function (rec) {
    var db = this.db;
    return tx(db, ['packs'], 'readwrite', function (t) { t.objectStore('packs').put(rec); });
  };

  /* Fichiers audio d'une scène : Map chemin -> Blob. */
  Library.prototype.getAudio = function (packId, sid) {
    var db = this.db, prefix = packId + '/' + sid + '/';
    return new Promise(function (res, rej) {
      var t = db.transaction(['audio'], 'readonly'), out = new Map();
      var c = t.objectStore('audio').openCursor(IDBKeyRange.bound(prefix, prefix + '￿'));
      c.onsuccess = function () {
        var cur = c.result;
        if (cur) { out.set(cur.key.slice(prefix.length), cur.value); cur.continue(); } else res(out);
      };
      c.onerror = function () { rej(c.error); };
    });
  };

  function deleteRange(store, prefix) {
    return new Promise(function (res, rej) {
      var c = store.openCursor(IDBKeyRange.bound(prefix, prefix + '￿'));
      c.onsuccess = function () { var cur = c.result; if (cur) { cur.delete(); cur.continue(); } else res(); };
      c.onerror = function () { rej(c.error); };
    });
  }

  Library.prototype.deleteScene = function (packId, sid) {
    var db = this.db;
    return tx(db, ['scenes', 'audio', 'packs'], 'readwrite', function (t) {
      t.objectStore('scenes').delete(packId + '/' + sid);
      deleteRange(t.objectStore('audio'), packId + '/' + sid + '/');
      var ps = t.objectStore('packs'), g = ps.get(packId);
      g.onsuccess = function () {
        var p = g.result;
        if (p) { p.scenes = p.scenes.filter(function (s) { return s.id !== sid; }); ps.put(p); }
      };
    });
  };

  Library.prototype.deletePack = function (packId) {
    var db = this.db;
    return tx(db, ['scenes', 'audio', 'packs'], 'readwrite', function (t) {
      t.objectStore('packs').delete(packId);
      deleteRange(t.objectStore('scenes'), packId + '/');
      deleteRange(t.objectStore('audio'), packId + '/');
    });
  };

  var api = { Library: Library };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Repete = root.Repete || {}; root.Repete.db = api; }
})(typeof window !== 'undefined' ? window : globalThis);

/* Répète — cible PWA : bibliothèque (import de packs, scènes disponibles, taille, suppression) et lancement du lecteur. */
(function (root) {
  'use strict';
  var R = root.Repete, pack = R.pack, dbm = R.db;
  var $ = function (s, el) { return (el || document).querySelector(s); };

  function h(tag, attrs, kids) {
    var el = document.createElement(tag), k;
    for (k in (attrs || {})) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  function fmtSize(b) { return b >= 1e6 ? (b / 1e6).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(b / 1e3)) + ' Ko'; }
  function fmtDur(s) { return Math.floor(s / 60) + ' min ' + ('0' + Math.round(s % 60)).slice(-2) + ' s'; }

  /* Import d'un pack : fusion incrémentale (même pack_id). Retourne un résumé. */
  async function importPack(lib, file, opts) {
    opts = opts || {};
    var progress = opts.progress || function () {};
    var rp = await pack.readPack(file), manifest = rp.manifest;
    var existing = await lib.getPack(manifest.pack_id);
    if (existing && existing.provider && manifest.play.provider && existing.provider !== manifest.play.provider) {
      var ok = opts.confirm ? await opts.confirm('Cette pièce a déjà été importée avec des voix « ' + existing.provider + ' » ; ce pack utilise « ' + manifest.play.provider +
        ' ». Une pièce devrait garder les mêmes voix du début à la fin. Importer quand même ?') : true;
      if (!ok) return { cancelled: true };
    }
    var added = 0, updated = 0, same = 0, scenesRec = {};
    (existing ? existing.scenes : []).forEach(function (s) { scenesRec[s.id] = s; });
    for (var i = 0; i < manifest.scenes.length; i++) {
      var ms = manifest.scenes[i], sc = rp.scenes[ms.id];
      progress('Scène ' + (i + 1) + ' / ' + manifest.scenes.length + ' : ' + ms.title);
      var cur = await lib.getScene(manifest.pack_id, ms.id);
      if (cur && cur.revision === ms.revision && cur.provider === ms.provider) { same++; continue; }
      var files = pack.sceneFiles(sc), audio = new Map(), size = 0;
      for (var k = 0; k < files.length; k++) {
        var blob = await rp.zip.readBlob('scenes/' + pack.sceneTag(ms.id) + '/' + files[k], 'audio/mpeg');
        audio.set(files[k], blob); size += blob.size;
      }
      await lib.putScene(manifest.pack_id, ms.id, { title: ms.title, revision: ms.revision, provider: ms.provider,
        duration: ms.duration, size: size, data: sc }, audio);
      scenesRec[ms.id] = { id: ms.id, title: ms.title, revision: ms.revision, duration: ms.duration, size: size,
                           has_full: !!(sc.scene && sc.scene.full_audio) };
      if (cur) updated++; else added++;
    }
    var roles = {};
    (existing ? existing.roles : []).forEach(function (r) { roles[r.id] = r; });
    manifest.roles.forEach(function (r) { roles[r.id] = r; });
    var order = function (a, b) { return String(a.id).localeCompare(String(b.id), undefined, { numeric: true }); };
    await lib.putPack({ pack_id: manifest.pack_id, title: manifest.play.title, provider: manifest.play.provider,
      roles: Object.keys(roles).map(function (k) { return roles[k]; }),
      scenes: Object.keys(scenesRec).map(function (k) { return scenesRec[k]; }).sort(order), updated: Date.now() });
    return { added: added, updated: updated, same: same, title: manifest.play.title, packId: manifest.pack_id };
  }

  function Library(rootEl, lib) { this.root = rootEl; this.lib = lib; this.urls = []; this.message = ''; }

  Library.prototype.show = async function () {
    var self = this;
    this.revoke();
    this.root.innerHTML = '';
    var packs = await this.lib.listPacks();
    var est = null;
    try { if (navigator.storage && navigator.storage.estimate) est = await navigator.storage.estimate(); } catch (e) { /* ignoré */ }
    var persisted = null;
    try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { /* ignoré */ }

    var input = h('input', { type: 'file', multiple: true, id: 'pack-input', hidden: true,
      onchange: function () { self.doImport(Array.prototype.slice.call(input.files)); input.value = ''; } });
    var online = h('span', { class: 'pill', id: 'net' });
    var setNet = function () { online.textContent = navigator.onLine ? 'en ligne' : 'hors ligne'; online.classList.toggle('off', !navigator.onLine); };
    setNet();
    if (!this._netBound) { this._netBound = true; root.addEventListener("online", function () { var n = $("#net"); if (n) { n.textContent = "en ligne"; n.classList.remove("off"); } }); root.addEventListener("offline", function () { var n = $("#net"); if (n) { n.textContent = "hors ligne"; n.classList.add("off"); } }); }

    var head = h('header', { class: 'bar lib-bar' }, [h('div', { class: 'titles' }, [h('div', { class: 'play', text: 'Répète' }), h('div', { class: 'big-title', text: 'Bibliothèque' })]), online]);
    var body = h('main', { class: 'lib' });
    this.status = h('div', { class: 'banner', id: 'lib-status', hidden: !this.message, text: this.message });
    body.appendChild(this.status);
    var def = root.REPETE_DEFAULT;
    if (def && !packs.some(function (p) { return p.pack_id === def.pack_id; })) body.appendChild(this.defaultCard(def));
    body.appendChild(h('div', { class: 'import-row' }, [
      h('button', { class: 'primary big', id: 'btn-import', text: 'Importer un pack', onclick: function () { input.click(); } }),
      h('p', { class: 'hint', text: 'Un pack est un fichier « .theatrepack » reçu par AirDrop, WhatsApp, mail ou lien. Tu l’importes une fois : ensuite tout fonctionne sans connexion.' })
    ]));
    if (!packs.length) {
      body.appendChild(h('div', { class: 'empty' }, [
        h('h2', { text: 'Aucune pièce pour l’instant' }),
        h('p', { text: 'Importe le pack de ta pièce pour commencer. Les packs ne sont jamais envoyés sur Internet par cette application.' })]));
    }
    packs.forEach(function (p) { body.appendChild(self.card(p)); });
    var foot = h('footer', { class: 'lib-foot' });
    var total = packs.reduce(function (a, p) { return a + p.scenes.reduce(function (b, s) { return b + (s.size || 0); }, 0); }, 0);
    foot.appendChild(h('p', { class: 'hint', text: 'Espace utilisé par les pièces : ' + fmtSize(total) + (est && est.quota ? ' sur ' + fmtSize(est.quota) + ' disponibles' : '') + '.' }));
    if (persisted === false) foot.appendChild(h('p', { class: 'hint', text: 'Le navigateur peut effacer ces données s’il manque de place. Sur iPhone : Partager → « Sur l’écran d’accueil » pour les protéger. Le fichier pack reste ta copie de référence.' }));
    else if (persisted) foot.appendChild(h('p', { class: 'hint', text: 'Stockage protégé : les données ne seront pas effacées automatiquement.' }));
    body.appendChild(foot);
    this.root.appendChild(head); this.root.appendChild(body); this.root.appendChild(input);
  };

  /* Pièce embarquée par défaut dans l'application : un appui l'ajoute à la bibliothèque, sans fichier à importer. */
  Library.prototype.defaultCard = function (def) {
    var self = this;
    return h('section', { class: 'demo-card', 'aria-label': 'Pièce par défaut' }, [
      h('div', { class: 'hint caps', text: 'Pièce par défaut' }),
      h('h2', { text: def.title }),
      h('p', { text: def.scenes + ' scène' + (def.scenes > 1 ? 's' : '') + ' · ' + fmtDur(def.duration) + ' · voix de synthèse · ' + fmtSize(def.size) +
        '. Embarquée dans l’application : une fois ajoutée, elle marche hors ligne.' }),
      h('button', { class: 'primary big', id: 'btn-default', text: 'Ajouter à ma bibliothèque', onclick: function () { self.addDefault(def); } })
    ]);
  };

  Library.prototype.addDefault = async function (def) {
    var self = this, btn = $('#btn-default');
    if (btn) btn.disabled = true;
    this.setStatus('Téléchargement de la pièce…');
    try {
      var res = await root.fetch(def.url);
      if (!res.ok) throw new Error('réponse ' + res.status);
      var blob = await res.blob();
      var r = await importPack(this.lib, blob, { progress: function (m) { self.setStatus('Ajout de la pièce — ' + m); } });
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignoré */ }
      this.message = '« ' + r.title + ' » ajoutée : ' + r.added + ' scène(s). Choisis une scène et touche « Répéter ».';
      await this.show();
    } catch (e) {
      if (btn) btn.disabled = false;
      this.setStatus('La pièce n’a pas pu être chargée. Ouvre l’application une fois avec une connexion, puis réessaie. (' + (e && e.message ? e.message : e) + ')');
    }
  };

  Library.prototype.card = function (p) {
    var self = this;
    var size = p.scenes.reduce(function (a, s) { return a + (s.size || 0); }, 0);
    var card = h('section', { class: 'pack-card', 'aria-label': p.title });
    card.appendChild(h('div', { class: 'pack-head' }, [
      h('div', {}, [h('h2', { text: p.title }), h('div', { class: 'hint', text: p.scenes.length + ' scène' + (p.scenes.length > 1 ? 's' : '') + ' · ' + fmtSize(size) + ' · voix ' + p.provider })]),
      h('button', { class: 'danger', 'aria-label': 'Supprimer la pièce ' + p.title, text: 'Supprimer', onclick: function () {
        if (root.confirm('Supprimer « ' + p.title + ' » de cet appareil ? Tu pourras la réimporter depuis le fichier pack.')) {
          self.lib.deletePack(p.pack_id).then(function () { self.message = 'Pièce supprimée.'; self.show(); });
        } } })
    ]));
    var list = h('ul', { class: 'scene-list' });
    p.scenes.forEach(function (s) {
      var li = h('li', {}, [
        h('div', { class: 'scene-info' }, [h('b', { text: s.title }), h('span', { class: 'hint', text: ' ' + fmtDur(s.duration) + ' · ' + fmtSize(s.size) })]),
        h('div', { class: 'scene-actions' }, [
          h('button', { class: 'primary', text: 'Répéter', onclick: function () { self.open(p.pack_id, s.id); } }),
          s.has_full ? h('button', { text: 'Écouter', 'aria-label': 'Écouter la scène complète ' + s.title, onclick: function () { self.listen(p, s); } }) : null,
          h('button', { class: 'ghost', 'aria-label': 'Supprimer la scène ' + s.title, text: '✕', onclick: function () {
            if (root.confirm('Supprimer la scène « ' + s.title + ' » ?')) self.lib.deleteScene(p.pack_id, s.id).then(function () { self.show(); });
          } })
        ])]);
      list.appendChild(li);
    });
    card.appendChild(list);
    return card;
  };

  Library.prototype.doImport = async function (files) {
    var self = this, btn = $('#btn-import');
    if (btn) btn.disabled = true;
    var done = [];
    for (var i = 0; i < files.length; i++) {
      try {
        var r = await importPack(this.lib, files[i], {
          progress: function (m) { self.setStatus('Import de « ' + files[i].name + ' » — ' + m); },
          confirm: function (m) { return Promise.resolve(root.confirm(m)); } });
        if (r.cancelled) done.push('Import annulé : ' + files[i].name);
        else done.push('« ' + r.title + ' » : ' + r.added + ' scène(s) ajoutée(s), ' + r.updated + ' mise(s) à jour, ' + r.same + ' inchangée(s).');
      } catch (e) { done.push('Import impossible (' + files[i].name + ') : ' + (e && e.message ? e.message : e)); }
    }
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignoré */ }
    this.message = done.join(' ');
    await this.show();
  };

  Library.prototype.setStatus = function (m) { if (this.status) { this.status.hidden = false; this.status.textContent = m; } };

  Library.prototype.revoke = function () { this.urls.forEach(function (u) { URL.revokeObjectURL(u); }); this.urls = []; };

  Library.prototype.listen = async function (p, s) {
    var self = this;
    var sc = await this.lib.getScene(p.pack_id, s.id);
    var audio = await this.lib.getAudio(p.pack_id, s.id);
    var blob = audio.get(sc.data.scene.full_audio);
    if (!blob) { this.setStatus('MP3 complet absent de ce pack.'); return; }
    var url = URL.createObjectURL(blob);
    this.urls.push(url);
    var sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Écoute de la scène' });
    var el = h('audio', { controls: true, src: url, preload: 'auto' });
    sheet.appendChild(h('div', { class: 'panel' }, [h('h2', { text: s.title }), h('p', { class: 'hint', text: p.title + ' — écoute passive (écran verrouillé possible).' }), el,
      h('div', { class: 'row-end' }, [h('button', { class: 'primary', text: 'Fermer', onclick: function () { el.pause(); sheet.remove(); } })])]));
    this.root.appendChild(sheet);
    try {
      if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: p.title, album: 'Répète' });
    } catch (e) { /* ignoré */ }
  };

  Library.prototype.open = async function (packId, sid) {
    var self = this;
    var p = await this.lib.getPack(packId);
    var recs = await this.lib.listScenes(packId);
    var scenes = {}, mscenes = [];
    recs.sort(function (a, b) { return String(a.id).localeCompare(String(b.id), undefined, { numeric: true }); })
      .forEach(function (r) { scenes[r.id] = r.data; mscenes.push({ id: r.id, title: r.title }); });
    var urls = {}, current = [];
    var data = {
      manifest: { pack_id: packId, play: { title: p.title }, roles: p.roles, scenes: mscenes },
      scenes: scenes, startScene: sid,
      audioUrl: function (sceneId, file) { return urls[sceneId + '/' + file]; },
      prepare: async function (id) {
        current.forEach(function (u) { URL.revokeObjectURL(u); }); current = []; urls = {};
        var map = await self.lib.getAudio(packId, id);
        map.forEach(function (blob, path) { var u = URL.createObjectURL(blob); current.push(u); urls[id + '/' + path] = u; });
      },
      onBack: function () { current.forEach(function (u) { URL.revokeObjectURL(u); }); self.show(); }
    };
    var app = new R.ui.App(data, function (urlFor) { return new R.engine.Engine(urlFor); });
    this.root.innerHTML = '';
    app.mount(this.root);
    root.__repete = app;
  };

  async function start(rootEl) {
    var lib = await dbm.Library.open();
    var ui = new Library(rootEl, lib);
    await ui.show();
    return ui;
  }

  R.library = { start: start, importPack: importPack, Library: Library };
})(typeof window !== 'undefined' ? window : globalThis);

/* Répète — amorçage de la cible PWA : service worker (coque hors ligne), stockage persistant, bibliothèque. */
(function () {
  'use strict';
  var R = window.Repete, rootEl = document.getElementById('app');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').then(function (reg) {
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (nw) nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              var b = document.getElementById('lib-status');
              if (b) { b.hidden = false; b.textContent = 'Une nouvelle version de Répète est prête : elle s’appliquera à la prochaine ouverture.'; }
            }
          });
        });
      }).catch(function () { /* l'application reste utilisable sans service worker, mais pas hors ligne */ });
    });
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignoré */ }

  R.library.start(rootEl).catch(function (e) {
    rootEl.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'banner error';
    p.textContent = 'Le stockage local est indisponible (navigation privée ?). Ouvre Répète dans une fenêtre normale. ' + (e && e.message ? e.message : '');
    rootEl.appendChild(p);
  });
})();
