/*
 * storage.test.js — checks for js/storage.js. Runs in a browser (IndexedDB is a browser feature).
 * Uses its own database, "teaching-dashboard-TEST", which is deleted before and after each test,
 * so your real dashboard data is never touched.
 */
(function (root) {
  'use strict';

  var TEST_DB = 'teaching-dashboard-TEST';
  var Storage = root.TDStorage;
  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  function eq(actual, expected, what) {
    if (actual !== expected) {
      throw new Error((what || 'value') + ': expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
    }
  }
  function ok(cond, what) { if (!cond) throw new Error(what); }

  // Opens a fresh, empty test database, runs fn(store), always closes it.
  function withFreshStore(fn) {
    return Storage.deleteDatabase(TEST_DB).then(function () {
      return Storage.open(TEST_DB);
    }).then(function (store) {
      return Promise.resolve().then(function () { return fn(store); })
        .then(function (r) { store.close(); return r; }, function (e) { store.close(); throw e; });
    });
  }

  function expectRejection(promise, messagePart) {
    return promise.then(function () {
      throw new Error('expected this to be refused, but it was accepted');
    }, function (e) {
      if (messagePart && String(e.message).indexOf(messagePart) === -1) {
        throw new Error('refused with the wrong message: "' + e.message + '"');
      }
    });
  }

  // Adds the classes used across tests; resolves with { y7, y10, y12 } saved records.
  function addSampleClasses(store) {
    var made = {};
    return store.saveClass({ name: '7A/Cp', subject: 'Computing' }).then(function (c) { made.y7 = c;
      return store.saveClass({ name: '10X/Cs1', subject: 'GCSE CS' }); }).then(function (c) { made.y10 = c;
      return store.saveClass({ name: '12/Cs', subject: 'A Level CS' }); }).then(function (c) { made.y12 = c;
      return made; });
  }

  // ---- Classes ----
  test('A new database starts empty, with a 5 × 5 timetable of free periods', function () {
    return withFreshStore(function (store) {
      return store.loadAll().then(function (all) {
        eq(all.classes.length, 0, 'classes');
        for (var d = 1; d <= 5; d++) {
          eq(all.timetable[d].length, 5, 'periods on day ' + d);
          all.timetable[d].forEach(function (s) { eq(s, null, 'slot'); });
        }
        eq(all.lastChangedAt, null, 'last changed');
      });
    });
  });

  test('Adding a class saves it with an id; it is there when loaded back', function () {
    return withFreshStore(function (store) {
      return store.saveClass({ name: '  10X/Cs1 ', subject: 'GCSE CS' }).then(function (saved) {
        ok(saved.id, 'the class was given an id');
        eq(saved.name, '10X/Cs1', 'name is trimmed');
        return store.loadAll();
      }).then(function (all) {
        eq(all.classes.length, 1, 'classes');
        eq(all.classes[0].subject, 'GCSE CS', 'subject');
        ok(all.lastChangedAt, 'last-changed time recorded');
      });
    });
  });

  test('Classes load in a natural order (7A before 10X before 12)', function () {
    return withFreshStore(function (store) {
      return store.saveClass({ name: '12/Cs', subject: 'A Level CS' })
        .then(function () { return store.saveClass({ name: '7A/Cp', subject: 'Computing' }); })
        .then(function () { return store.saveClass({ name: '10X/Cs1', subject: 'GCSE CS' }); })
        .then(function () { return store.loadAll(); })
        .then(function (all) {
          eq(all.classes.map(function (c) { return c.name; }).join(', '), '7A/Cp, 10X/Cs1, 12/Cs', 'order');
        });
    });
  });

  test('Editing a class changes it rather than adding a second one', function () {
    return withFreshStore(function (store) {
      return store.saveClass({ name: '8B/Cp', subject: 'Computing' }).then(function (c) {
        return store.saveClass({ id: c.id, name: '8B/Cp', subject: 'Digital Literacy' });
      }).then(function () { return store.loadAll(); }).then(function (all) {
        eq(all.classes.length, 1, 'classes');
        eq(all.classes[0].subject, 'Digital Literacy', 'subject');
      });
    });
  });

  test('A class with no name, or no subject, is refused', function () {
    return withFreshStore(function (store) {
      return expectRejection(store.saveClass({ name: '  ', subject: 'Computing' }), 'name')
        .then(function () { return expectRejection(store.saveClass({ name: '9C/Cp', subject: '' }), 'subject'); });
    });
  });

  test('Two classes with the same name (any capitals) are refused', function () {
    return withFreshStore(function (store) {
      return store.saveClass({ name: '9C/Cp', subject: 'Computing' }).then(function () {
        return expectRejection(store.saveClass({ name: '9c/cp', subject: 'Computing' }), 'already have');
      });
    });
  });

  // ---- Timetable ----
  test('Assigning a class to a period saves it; the subject comes from the class', function () {
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function (c) {
        return store.setSlot(5, 2, { classId: c.y10.id }).then(function () { return store.loadAll(); })
          .then(function (all) {
            eq(all.timetable[5][2].classId, c.y10.id, 'Friday P3');
            eq(all.timetable[5][2].subjectOverride, undefined, 'no override');
            var r = Schedule.resolveSlot(all.timetable[5][2], all.classes);
            eq(r.subject, 'GCSE CS', 'subject shown');
          });
      });
    });
  });

  test('A lesson-only subject is kept; the class default is unchanged', function () {
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function (c) {
        return store.setSlot(3, 1, { classId: c.y7.id, subjectOverride: 'Digital Literacy' })
          .then(function () { return store.loadAll(); })
          .then(function (all) {
            eq(all.timetable[3][1].subjectOverride, 'Digital Literacy', 'override');
            var y7 = all.classes.filter(function (x) { return x.id === c.y7.id; })[0];
            eq(y7.subject, 'Computing', 'class default');
          });
      });
    });
  });

  test('Choosing the class default as the "override" is not stored as an override', function () {
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function (c) {
        return store.setSlot(1, 0, { classId: c.y12.id, subjectOverride: 'A Level CS' })
          .then(function () { return store.loadAll(); })
          .then(function (all) { eq(all.timetable[1][0].subjectOverride, undefined, 'override'); });
      });
    });
  });

  test('Setting a period to free removes the lesson', function () {
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function (c) {
        return store.setSlot(2, 4, { classId: c.y7.id })
          .then(function () { return store.setSlot(2, 4, null); })
          .then(function () { return store.loadAll(); })
          .then(function (all) { eq(all.timetable[2][4], null, 'Tuesday P5'); });
      });
    });
  });

  test('A lesson for a class that does not exist is refused', function () {
    return withFreshStore(function (store) {
      return expectRejection(store.setSlot(1, 0, { classId: 'no-such-class' }), 'no longer exists');
    });
  });

  test('Weekends and period numbers outside P1–P5 are refused', function () {
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function (c) {
        return expectRejection(store.setSlot(6, 0, { classId: c.y7.id }), 'Weekday')
          .then(function () { return expectRejection(store.setSlot(1, 5, { classId: c.y7.id }), 'Period'); });
      });
    });
  });

  // ---- Deleting a class ----
  test('Before deleting, the dashboard can say how many lessons will become free', function () {
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function (c) {
        return store.setSlot(1, 0, { classId: c.y10.id })
          .then(function () { return store.setSlot(3, 2, { classId: c.y10.id }); })
          .then(function () { return store.setSlot(5, 2, { classId: c.y12.id }); })
          .then(function () { return store.countLessonsForClass(c.y10.id); })
          .then(function (n) { eq(n, 2, 'lessons for 10X/Cs1'); });
      });
    });
  });

  test('Deleting a class removes it and turns only its lessons into free periods', function () {
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function (c) {
        return store.setSlot(1, 0, { classId: c.y10.id })
          .then(function () { return store.setSlot(3, 2, { classId: c.y10.id }); })
          .then(function () { return store.setSlot(5, 2, { classId: c.y12.id }); })
          .then(function () { return store.deleteClass(c.y10.id); })
          .then(function (freed) { eq(freed, 2, 'lessons freed'); return store.loadAll(); })
          .then(function (all) {
            eq(all.classes.length, 2, 'classes left');
            eq(all.timetable[1][0], null, 'Monday P1');
            eq(all.timetable[3][2], null, 'Wednesday P3');
            eq(all.timetable[5][2].classId, c.y12.id, 'Friday P3 (other class) kept');
          });
      });
    });
  });

  // ---- Saving is real ----
  test('Changes are still there after closing and reopening the database', function () {
    return Storage.deleteDatabase(TEST_DB).then(function () { return Storage.open(TEST_DB); })
      .then(function (store) {
        return addSampleClasses(store).then(function (c) {
          return store.setSlot(4, 3, { classId: c.y7.id, subjectOverride: 'Digital Literacy' });
        }).then(function () { store.close(); });
      })
      .then(function () { return Storage.open(TEST_DB); })
      .then(function (store) {
        return store.loadAll().then(function (all) {
          store.close();
          eq(all.classes.length, 3, 'classes');
          eq(all.timetable[4][3].subjectOverride, 'Digital Literacy', 'Thursday P4');
        });
      });
  });

  // ---- Backup ----
  test('Export produces a complete backup in the agreed format', function () {
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function (c) {
        return store.setSlot(5, 2, { classId: c.y10.id });
      }).then(function () { return store.exportData(); }).then(function (b) {
        eq(b.app, 'teaching-dashboard', 'app id');
        eq(b.formatVersion, 1, 'format version');
        ok(!isNaN(Date.parse(b.exportedAt)), 'export time present');
        eq(b.classes.length, 3, 'classes');
        eq(b.timetable[5].length, 5, 'Friday periods');
        var check = TDStorage.validateBackup(JSON.parse(JSON.stringify(b)));
        ok(check.ok, 'the exported file passes the restore check');
        eq(check.summary.lessonCount, 1, 'lessons counted');
      });
    });
  });

  test('Recording a backup stores the time, for the "last backup" panel', function () {
    return withFreshStore(function (store) {
      var when = new Date(2026, 10, 9, 15, 40);
      return store.markBackedUp(when).then(function () { return store.loadAll(); })
        .then(function (all) { eq(all.lastBackupAt, when.toISOString(), 'last backup'); });
    });
  });

  // ---- Restore: checking files ----
  test('A file that is not a dashboard backup is rejected', function () {
    var v = TDStorage.validateBackup({ name: 'something else' });
    eq(v.ok, false, 'accepted');
    eq(v.errors[0], 'This file is not a Teaching Dashboard backup.', 'message');
  });

  test('A backup from a newer version of the dashboard is rejected', function () {
    var v = TDStorage.validateBackup({ app: 'teaching-dashboard', formatVersion: 99, classes: [], timetable: {} });
    eq(v.ok, false, 'accepted');
  });

  test('A backup whose lesson points to a missing class is rejected', function () {
    var v = TDStorage.validateBackup({
      app: 'teaching-dashboard', formatVersion: 1, classes: [{ id: 'a', name: '7A', subject: 'Computing' }],
      timetable: { 1: [{ classId: 'zzz' }, null, null, null, null] }
    });
    eq(v.ok, false, 'accepted');
    ok(v.errors[0].indexOf('not in the backup') !== -1, 'explains why');
  });

  test('A backup with a day that does not have exactly 5 periods is rejected', function () {
    var v = TDStorage.validateBackup({
      app: 'teaching-dashboard', formatVersion: 1, classes: [], timetable: { 2: [null, null] }
    });
    eq(v.ok, false, 'accepted');
  });

  // ---- Restore: replacing ----
  test('Restoring replaces everything — nothing from before is merged in', function () {
    var backup = {
      app: 'teaching-dashboard', formatVersion: 1, exportedAt: '2026-10-02T15:00:00.000Z',
      classes: [{ id: 'b1', name: '11Y/Cs1', subject: 'GCSE CS' }],
      timetable: { 1: [null, { classId: 'b1' }, null, null, null] }
    };
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function (c) {
        return store.setSlot(5, 2, { classId: c.y10.id });
      }).then(function () { return store.restoreFromBackup(backup); })
        .then(function (summary) {
          eq(summary.classCount, 1, 'summary classes');
          eq(summary.lessonCount, 1, 'summary lessons');
          return store.loadAll();
        }).then(function (all) {
          eq(all.classes.length, 1, 'classes after restore');
          eq(all.classes[0].name, '11Y/Cs1', 'class');
          eq(all.timetable[5][2], null, 'old Friday lesson gone');
          eq(all.timetable[1][1].classId, 'b1', 'Monday P2 from backup');
        });
    });
  });

  test('An invalid backup changes nothing', function () {
    return withFreshStore(function (store) {
      return addSampleClasses(store).then(function () {
        return store.restoreFromBackup({ app: 'teaching-dashboard', formatVersion: 1, classes: 'oops', timetable: {} })
          .then(function () { throw new Error('the invalid backup was accepted'); },
                function (e) { ok(e.problems && e.problems.length, 'problems listed'); });
      }).then(function () { return store.loadAll(); })
        .then(function (all) { eq(all.classes.length, 3, 'classes untouched'); });
    });
  });

  test('A restore can be undone, bringing back exactly the data from before', function () {
    var backup = {
      app: 'teaching-dashboard', formatVersion: 1,
      classes: [{ id: 'b1', name: '11Y/Cs1', subject: 'GCSE CS' }], timetable: {}
    };
    return withFreshStore(function (store) {
      var savedY10;
      return addSampleClasses(store).then(function (c) {
        savedY10 = c.y10;
        return store.setSlot(5, 2, { classId: c.y10.id, subjectOverride: 'Revision' });
      }).then(function () { return store.restoreFromBackup(backup); })
        .then(function () { return store.getUndoInfo(); })
        .then(function (info) {
          eq(info.classCount, 3, 'undo info: classes');
          eq(info.lessonCount, 1, 'undo info: lessons');
          return store.undoRestore();
        })
        .then(function () { return store.loadAll(); })
        .then(function (all) {
          eq(all.classes.length, 3, 'classes back');
          eq(all.timetable[5][2].classId, savedY10.id, 'Friday P3 back');
          eq(all.timetable[5][2].subjectOverride, 'Revision', 'override back');
          return store.getUndoInfo();
        })
        .then(function (info) { eq(info, null, 'undo used up'); });
    });
  });

  // ---- Runner ----
  function runAll() {
    if (!Storage || !root.indexedDB) {
      return Promise.resolve([{ name: 'Storage is available in this browser', passed: false,
        error: 'IndexedDB is not available here. Open the dashboard from its web address to test storage.' }]);
    }
    var results = [];
    return tests.reduce(function (chain, t) {
      return chain.then(function () {
        return Promise.resolve().then(t.fn).then(
          function () { results.push({ name: t.name, passed: true }); },
          function (e) { results.push({ name: t.name, passed: false, error: e && e.message ? e.message : String(e) }); }
        );
      });
    }, Promise.resolve()).then(function () {
      return Storage.deleteDatabase(TEST_DB).then(function () { return results; }, function () { return results; });
    });
  }

  root.StorageTests = { runAll: runAll };
})(this);
