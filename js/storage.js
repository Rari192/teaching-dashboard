/*
 * storage.js — saves and loads all dashboard data on the device, using IndexedDB.
 *
 * Every change is written in a single transaction and the returned promise only
 * resolves once the device confirms the write is complete. That is what lets the
 * screens show "Saved" honestly.
 *
 * What is stored (object stores in the database):
 *   classes   : { id, name, subject }
 *   slots     : { key: "3-1", weekday: 3, periodIndex: 1, classId, subjectOverride? }
 *               (only lessons are stored; a missing slot is a free period)
 *   meta      : { key, value }  — lastChangedAt, lastBackupAt
 *   snapshots : { key: "pre-restore", savedAt, data }  — safety copy for undoing a restore
 *
 * Backup file format (also what exportData() returns):
 *   { app: "teaching-dashboard", formatVersion: 1, exportedAt: ISO string,
 *     classes: [{ id, name, subject }],
 *     timetable: { "1": [slot|null x5], ..., "5": [...] } }
 *   where a slot is { classId } or { classId, subjectOverride }.
 */
(function (root) {
  'use strict';

  var DEFAULT_DB_NAME = 'teaching-dashboard';
  var DB_VERSION = 1;
  var APP_ID = 'teaching-dashboard';
  var FORMAT_VERSION = 1;
  var DAYS = [1, 2, 3, 4, 5];
  var PERIOD_COUNT = 5;
  var STORES = ['classes', 'slots', 'meta', 'snapshots'];

  // ---------- small IndexedDB helpers ----------

  function promisifyRequest(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // Runs `work(stores)` inside one transaction. Resolves with work's result only
  // after the transaction has fully completed (data is on disk), rejects if anything fails.
  function transact(db, storeNames, mode, work) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeNames, mode);
      var stores = {};
      storeNames.forEach(function (n) { stores[n] = tx.objectStore(n); });
      var result;
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('Save was cancelled')); };
      try {
        Promise.resolve(work(stores, tx)).then(function (r) { result = r; }, function (e) {
          try { tx.abort(); } catch (ignore) {}
          reject(e);
        });
      } catch (e) {
        try { tx.abort(); } catch (ignore) {}
        reject(e);
      }
    });
  }

  function openDatabase(name) {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('This browser has no IndexedDB storage.')); return; }
      var req = root.indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('classes')) db.createObjectStore('classes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('slots')) {
          var slots = db.createObjectStore('slots', { keyPath: 'key' });
          slots.createIndex('byClass', 'classId', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('Storage is in use by another copy of the app. Close other tabs and try again.')); };
    });
  }

  // ---------- validation shared by edits and restores ----------

  function cleanText(value) { return typeof value === 'string' ? value.trim() : ''; }

  function slotKey(weekday, periodIndex) { return weekday + '-' + periodIndex; }

  function checkWeekdayPeriod(weekday, periodIndex) {
    if (DAYS.indexOf(weekday) === -1) throw new Error('Weekday must be 1 (Monday) to 5 (Friday).');
    if (!(periodIndex >= 0 && periodIndex < PERIOD_COUNT) || Math.floor(periodIndex) !== periodIndex) {
      throw new Error('Period must be 0 to 4.');
    }
  }

  function newId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function emptyTimetable() {
    var t = {};
    DAYS.forEach(function (d) { t[d] = [null, null, null, null, null]; });
    return t;
  }

  // Checks a parsed backup file. Never changes anything.
  // Returns { ok: true, summary } or { ok: false, errors: [...] }.
  function validateBackup(data) {
    var errors = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, errors: ['This file is not a Teaching Dashboard backup.'] };
    }
    if (data.app !== APP_ID) {
      return { ok: false, errors: ['This file is not a Teaching Dashboard backup.'] };
    }
    if (typeof data.formatVersion !== 'number' || data.formatVersion > FORMAT_VERSION) {
      errors.push('This backup was made by a newer version of the dashboard.');
    }
    if (!Array.isArray(data.classes)) {
      errors.push('The backup has no list of classes.');
    }
    var ids = {};
    var names = {};
    (Array.isArray(data.classes) ? data.classes : []).forEach(function (c, i) {
      var label = 'Class ' + (i + 1);
      if (!c || typeof c !== 'object') { errors.push(label + ' is not readable.'); return; }
      if (!cleanText(c.id)) errors.push(label + ' has no id.');
      if (!cleanText(c.name)) errors.push(label + ' has no name.');
      if (typeof c.subject !== 'string') errors.push(label + ' has no subject.');
      if (ids[c.id]) errors.push('Two classes share the id "' + c.id + '".');
      var lower = cleanText(c.name).toLowerCase();
      if (lower && names[lower]) errors.push('Two classes are both called "' + c.name + '".');
      ids[c.id] = true;
      names[lower] = true;
    });
    var lessons = 0;
    if (!data.timetable || typeof data.timetable !== 'object') {
      errors.push('The backup has no timetable.');
    } else {
      DAYS.forEach(function (d) {
        var day = data.timetable[d];
        if (day === undefined) return; // a missing day is treated as all free
        if (!Array.isArray(day) || day.length !== PERIOD_COUNT) {
          errors.push('The timetable for day ' + d + ' does not have 5 periods.');
          return;
        }
        day.forEach(function (slot, p) {
          if (slot === null) return;
          if (!slot || typeof slot !== 'object' || !cleanText(slot.classId)) {
            errors.push('Day ' + d + ', period ' + (p + 1) + ' is not readable.');
          } else if (!ids[slot.classId]) {
            errors.push('Day ' + d + ', period ' + (p + 1) + ' refers to a class that is not in the backup.');
          } else {
            lessons++;
          }
        });
      });
    }
    if (errors.length) return { ok: false, errors: errors };
    return {
      ok: true,
      summary: {
        classCount: data.classes.length,
        lessonCount: lessons,
        exportedAt: data.exportedAt || null
      }
    };
  }

  // ---------- the storage object ----------

  function Storage(db) { this.db = db; }

  // Opens (or creates) the database. Pass a different name in tests.
  Storage.open = function (name) {
    return openDatabase(name || DEFAULT_DB_NAME).then(function (db) { return new Storage(db); });
  };

  // Removes a whole database. Used by tests only.
  Storage.deleteDatabase = function (name) {
    return promisifyRequest(root.indexedDB.deleteDatabase(name));
  };

  Storage.validateBackup = validateBackup;
  Storage.APP_ID = APP_ID;
  Storage.FORMAT_VERSION = FORMAT_VERSION;

  Storage.prototype.close = function () { this.db.close(); };

  // Asks the device not to clear this app's data when space runs low.
  // Resolves true if granted, false if refused or unsupported. Never throws.
  Storage.requestPersistence = function () {
    try {
      if (root.navigator && navigator.storage && navigator.storage.persist) {
        return navigator.storage.persist().catch(function () { return false; });
      }
    } catch (e) {}
    return Promise.resolve(false);
  };

  // Everything, in the shapes the rest of the app uses:
  // { classes: [...sorted by name], timetable: {1:[...5],...}, lastChangedAt, lastBackupAt }
  Storage.prototype.loadAll = function () {
    return transact(this.db, ['classes', 'slots', 'meta'], 'readonly', function (s) {
      return Promise.all([
        promisifyRequest(s.classes.getAll()),
        promisifyRequest(s.slots.getAll()),
        promisifyRequest(s.meta.getAll())
      ]).then(function (r) {
        var classes = r[0].sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
        var timetable = emptyTimetable();
        r[1].forEach(function (slot) {
          var entry = { classId: slot.classId };
          if (slot.subjectOverride) entry.subjectOverride = slot.subjectOverride;
          timetable[slot.weekday][slot.periodIndex] = entry;
        });
        var meta = {};
        r[2].forEach(function (m) { meta[m.key] = m.value; });
        return {
          classes: classes,
          timetable: timetable,
          lastChangedAt: meta.lastChangedAt || null,
          lastBackupAt: meta.lastBackupAt || null
        };
      });
    });
  };

  function touch(metaStore) {
    metaStore.put({ key: 'lastChangedAt', value: new Date().toISOString() });
  }

  // Adds a class (no id) or updates one (with id). Resolves with the saved class.
  Storage.prototype.saveClass = function (cls) {
    var name = cleanText(cls && cls.name);
    var subject = cleanText(cls && cls.subject);
    if (!name) return Promise.reject(new Error('Please give the class a name.'));
    if (!subject) return Promise.reject(new Error('Please choose a subject for this class.'));
    var record = { id: (cls.id || newId()), name: name, subject: subject };
    return transact(this.db, ['classes', 'meta'], 'readwrite', function (s) {
      return promisifyRequest(s.classes.getAll()).then(function (all) {
        var clash = all.some(function (c) { return c.id !== record.id && c.name.toLowerCase() === name.toLowerCase(); });
        if (clash) throw new Error('You already have a class called "' + name + '".');
        s.classes.put(record);
        touch(s.meta);
        return record;
      });
    });
  };

  // How many timetabled lessons use this class. For the delete warning.
  Storage.prototype.countLessonsForClass = function (classId) {
    return transact(this.db, ['slots'], 'readonly', function (s) {
      return promisifyRequest(s.slots.index('byClass').count(classId));
    });
  };

  // Deletes a class and, in the same transaction, turns its lessons into free periods.
  // Resolves with the number of lessons that became free.
  Storage.prototype.deleteClass = function (classId) {
    return transact(this.db, ['classes', 'slots', 'meta'], 'readwrite', function (s) {
      return promisifyRequest(s.slots.index('byClass').getAllKeys(classId)).then(function (keys) {
        keys.forEach(function (k) { s.slots.delete(k); });
        s.classes.delete(classId);
        touch(s.meta);
        return keys.length;
      });
    });
  };

  // Sets one timetable slot. Pass null for a free period,
  // or { classId } / { classId, subjectOverride }.
  Storage.prototype.setSlot = function (weekday, periodIndex, slot) {
    try { checkWeekdayPeriod(weekday, periodIndex); } catch (e) { return Promise.reject(e); }
    var key = slotKey(weekday, periodIndex);
    return transact(this.db, ['classes', 'slots', 'meta'], 'readwrite', function (s) {
      if (slot === null) {
        s.slots.delete(key);
        touch(s.meta);
        return null;
      }
      var classId = cleanText(slot && slot.classId);
      if (!classId) throw new Error('Choose a class, or mark the period as free.');
      return promisifyRequest(s.classes.get(classId)).then(function (cls) {
        if (!cls) throw new Error('That class no longer exists.');
        var record = { key: key, weekday: weekday, periodIndex: periodIndex, classId: classId };
        var override = cleanText(slot.subjectOverride);
        // An "override" identical to the class default is not an override.
        if (override && override !== cls.subject) record.subjectOverride = override;
        s.slots.put(record);
        touch(s.meta);
        return record;
      });
    });
  };

  // Builds the backup object (see format at the top) from data already loaded with loadAll().
  // Synchronous, so the share sheet can open immediately after a tap.
  Storage.buildBackup = function (all, when) {
    var timetable = {};
    DAYS.forEach(function (d) {
      timetable[d] = (all.timetable[d] || [null, null, null, null, null]).map(function (slot) {
        if (!slot) return null;
        var s = { classId: slot.classId };
        if (slot.subjectOverride) s.subjectOverride = slot.subjectOverride;
        return s;
      });
    });
    return {
      app: APP_ID,
      formatVersion: FORMAT_VERSION,
      exportedAt: (when || new Date()).toISOString(),
      classes: all.classes.map(function (c) { return { id: c.id, name: c.name, subject: c.subject }; }),
      timetable: timetable
    };
  };

  // Reads everything and builds the backup object. Does not change anything.
  Storage.prototype.exportData = function () {
    return this.loadAll().then(function (all) { return Storage.buildBackup(all); });
  };

  // Records that a backup file was successfully saved.
  Storage.prototype.markBackedUp = function (when) {
    var value = (when || new Date()).toISOString();
    return transact(this.db, ['meta'], 'readwrite', function (s) {
      s.meta.put({ key: 'lastBackupAt', value: value });
      return value;
    });
  };

  // Writes `data` (an already-validated backup) over everything, in one transaction.
  function replaceEverything(s, data) {
    s.classes.clear();
    s.slots.clear();
    data.classes.forEach(function (c) {
      s.classes.put({ id: c.id, name: cleanText(c.name), subject: cleanText(c.subject) });
    });
    DAYS.forEach(function (d) {
      var day = data.timetable[d] || [];
      day.forEach(function (slot, p) {
        if (!slot) return;
        var record = { key: slotKey(d, p), weekday: d, periodIndex: p, classId: slot.classId };
        if (cleanText(slot.subjectOverride)) record.subjectOverride = cleanText(slot.subjectOverride);
        s.slots.put(record);
      });
    });
    touch(s.meta);
  }

  // Replaces ALL data with a backup. Nothing is merged.
  // First keeps a copy of the current data (for undo). If anything fails, nothing changes.
  // Resolves with the backup's summary; rejects with the list of problems if the file is invalid.
  Storage.prototype.restoreFromBackup = function (data) {
    var check = validateBackup(data);
    if (!check.ok) {
      var err = new Error('This backup cannot be restored.');
      err.problems = check.errors;
      return Promise.reject(err);
    }
    var self = this;
    return this.exportData().then(function (current) {
      return transact(self.db, STORES, 'readwrite', function (s) {
        s.snapshots.put({ key: 'pre-restore', savedAt: new Date().toISOString(), data: current });
        replaceEverything(s, data);
        return check.summary;
      });
    });
  };

  // Details of the safety copy taken before the last restore, or null.
  Storage.prototype.getUndoInfo = function () {
    return transact(this.db, ['snapshots'], 'readonly', function (s) {
      return promisifyRequest(s.snapshots.get('pre-restore')).then(function (snap) {
        if (!snap) return null;
        var summary = validateBackup(snap.data).summary;
        return { savedAt: snap.savedAt, classCount: summary.classCount, lessonCount: summary.lessonCount };
      });
    });
  };

  // Puts back the data from before the last restore, then discards the safety copy.
  Storage.prototype.undoRestore = function () {
    return transact(this.db, STORES, 'readwrite', function (s) {
      return promisifyRequest(s.snapshots.get('pre-restore')).then(function (snap) {
        if (!snap) throw new Error('There is no restore to undo.');
        replaceEverything(s, snap.data);
        s.snapshots.delete('pre-restore');
        return true;
      });
    });
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Storage;
  } else {
    root.TDStorage = Storage;
  }
})(this);
