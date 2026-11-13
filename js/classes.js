/*
 * classes.js — the Classes screen: one place to set up each class and its default subject.
 *
 * Adding a class needs a name and a subject, so it has an explicit "Add class" button.
 * After that, every change saves the moment it is made.
 * Deleting a class always asks first and says how many lessons will become free.
 */
(function (root) {
  'use strict';

  var el = root.UI.el;
  var host = null;
  var selectedId = null;     // a class id, 'new', or null
  var newSubjectOpen = false;
  var draft = { name: '', subject: '' };   // the "New class" form before it is added
  var busy = false;

  function $(id) { return document.getElementById(id); }

  function classById(id) {
    return host.data().classes.filter(function (c) { return c.id === id; })[0] || null;
  }

  function lessonCounts(data) {
    var counts = {};
    for (var d = 1; d <= 5; d++) {
      (data.timetable[d] || []).forEach(function (slot) {
        if (slot) counts[slot.classId] = (counts[slot.classId] || 0) + 1;
      });
    }
    return counts;
  }

  function knownSubjects(data) {
    var seen = {}, list = [];
    data.classes.forEach(function (c) {
      var k = c.subject.toLowerCase();
      if (!seen[k]) { seen[k] = true; list.push(c.subject); }
    });
    return list.sort(function (a, b) { return a.localeCompare(b); });
  }

  function lessonsText(n) { return n === 1 ? '1 lesson a week' : n + ' lessons a week'; }

  // ---------- saved / not saved ----------

  function setStatus(state, message) {
    [$('classes-status'), $('class-panel-status')].forEach(function (t) {
      t.className = 'save-status is-' + state;
      t.textContent = '';
      if (state === 'saved') t.appendChild(root.UI.icon(root.UI.ICONS.check));
      t.appendChild(document.createTextNode(message));
    });
    $('classes-status').lastChild.textContent = state === 'saved' ? 'All changes saved' : message;
  }

  function showError(message) {
    var e = $('class-error');
    e.textContent = message;
    e.hidden = !message;
  }

  function save(change) {
    if (busy) return Promise.resolve(null);
    busy = true;
    showError('');
    setStatus('saving', 'Saving…');
    var result;
    return change().then(function (r) {
      result = r;
      return host.reload();
    }).then(function () {
      busy = false;
      setStatus('saved', 'Saved');
      return result === undefined ? true : result;
    }, function (err) {
      busy = false;
      setStatus('error', 'Not saved');
      showError((err && err.message ? err.message : 'Something went wrong.') + ' Nothing has been changed.');
      return null;
    });
  }

  // ---------- the list ----------

  function renderList() {
    var data = host.data();
    var counts = lessonCounts(data);
    var list = $('class-list');
    list.textContent = '';
    data.classes.forEach(function (c) {
      var b = el('button', 'class-row' + (c.id === selectedId ? ' is-selected' : ''));
      b.type = 'button';
      b.setAttribute('data-id', c.id);
      b.setAttribute('aria-pressed', c.id === selectedId ? 'true' : 'false');
      var left = el('span', 'class-row-main');
      left.appendChild(el('span', 'class-row-name', c.name));
      left.appendChild(el('span', 'class-row-count', lessonsText(counts[c.id] || 0)));
      b.appendChild(left);
      b.appendChild(el('span', 'class-row-subject', c.subject));
      list.appendChild(b);
    });
    $('class-list-empty').hidden = data.classes.length > 0;
  }

  // ---------- the panel ----------

  function subjectChips(current) {
    var data = host.data();
    var box = $('subject-options');
    box.textContent = '';
    knownSubjects(data).forEach(function (s) {
      var on = current && current.toLowerCase() === s.toLowerCase();
      var b = el('button', 'chip' + (on ? ' is-on' : ''), s);
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('data-subject', s);
      box.appendChild(b);
    });
    var noneYet = knownSubjects(data).length === 0;
    var add = el('button', 'chip chip-add', '+ New subject');
    add.type = 'button';
    add.id = 'btn-new-subject';
    add.hidden = newSubjectOpen || noneYet;
    box.appendChild(add);
    $('new-subject-row').hidden = !(newSubjectOpen || noneYet);
  }

  function renderPanel() {
    var isNew = selectedId === 'new';
    var cls = isNew ? null : classById(selectedId);
    $('class-panel').hidden = !isNew && !cls;
    $('class-panel-none').hidden = isNew || !!cls;
    if (!isNew && !cls) return;

    $('class-panel-title').textContent = isNew ? 'New class' : 'Edit class';
    var nameInput = $('class-name');
    if (document.activeElement !== nameInput) nameInput.value = isNew ? draft.name : cls.name;
    subjectChips(isNew ? draft.subject : cls.subject);
    if (isNew && draft.subject && knownSubjects(host.data()).indexOf(draft.subject) === -1) {
      // a brand-new subject typed for the new class: show it as chosen
      var b = el('button', 'chip is-on', draft.subject);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'true');
      b.setAttribute('data-subject', draft.subject);
      $('subject-options').insertBefore(b, $('btn-new-subject'));
    }

    $('class-note').hidden = isNew;
    $('new-class-actions').hidden = !isNew;
    $('btn-cancel-new').hidden = host.data().classes.length === 0;
    $('class-panel-foot').hidden = isNew;
  }

  function render() {
    var data = host.data();
    // Nothing chosen yet: pick the first class, or start a new one if there are none.
    if (selectedId !== 'new' && !classById(selectedId)) {
      selectedId = data.classes.length ? data.classes[0].id : 'new';
    }
    renderList();
    renderPanel();
  }

  // ---------- actions ----------

  function select(id) {
    commitName().then(function () {
      selectedId = id;
      newSubjectOpen = false;
      showError('');
      clearPanelStatus();
      render();
    });
  }

  function clearPanelStatus() {
    $('class-panel-status').className = 'save-status';
    $('class-panel-status').textContent = '';
  }

  function startNew() {
    commitName().then(function () {
      selectedId = 'new';
      draft = { name: '', subject: '' };
      newSubjectOpen = false;
      showError('');
      clearPanelStatus();
      render();
      $('class-name').focus();
    });
  }

  // Saves a changed class name (existing classes only). Called on Enter, on leaving the
  // field, and before moving elsewhere so nothing typed is lost.
  function commitName() {
    if (selectedId === 'new' || !selectedId) return Promise.resolve();
    var cls = classById(selectedId);
    if (!cls) return Promise.resolve();
    var typed = $('class-name').value.trim();
    if (typed === cls.name) return Promise.resolve();
    return save(function () {
      return host.store().saveClass({ id: cls.id, name: typed, subject: cls.subject });
    }).then(function (ok) {
      if (!ok) $('class-name').value = typed; // keep what was typed so it can be corrected
      render();
    });
  }

  function chooseSubject(subject) {
    var clean = (subject || '').trim();
    if (!clean) return;
    if (selectedId === 'new') {
      draft.subject = clean;
      draft.name = $('class-name').value;
      newSubjectOpen = false;
      renderPanel();
      return;
    }
    var cls = classById(selectedId);
    if (!cls || cls.subject === clean) return;
    save(function () {
      return host.store().saveClass({ id: cls.id, name: cls.name, subject: clean });
    }).then(function () {
      newSubjectOpen = false;
      $('new-subject-input').value = '';
      render();
    });
  }

  function addClass() {
    var name = $('class-name').value.trim();
    var subject = draft.subject || $('new-subject-input').value.trim();
    save(function () {
      return host.store().saveClass({ name: name, subject: subject });
    }).then(function (saved) {
      if (!saved) return;
      selectedId = saved.id;
      draft = { name: '', subject: '' };
      newSubjectOpen = false;
      $('new-subject-input').value = '';
      render();
      root.UI.toast(saved.name + ' added.');
    });
  }

  function deleteClass() {
    var cls = classById(selectedId);
    if (!cls) return;
    host.store().countLessonsForClass(cls.id).then(function (n) {
      var message = n === 0
        ? cls.name + ' is not in your timetable, so no lessons are affected.'
        : 'Its ' + (n === 1 ? 'lesson' : n + ' lessons') + ' in your timetable will become ' + (n === 1 ? 'a free period' : 'free periods') + '. This cannot be undone.';
      return root.UI.confirm({ title: 'Delete ' + cls.name + '?', message: message, confirmLabel: 'Delete class' });
    }).then(function (yes) {
      if (!yes) return;
      var name = cls.name;
      save(function () { return host.store().deleteClass(cls.id); }).then(function (freed) {
        if (freed === null) return;
        selectedId = null;
        render();
        root.UI.toast(name + ' deleted' + (freed ? '. ' + freed + (freed === 1 ? ' lesson is' : ' lessons are') + ' now free.' : '.'));
      });
    });
  }

  // ---------- wiring ----------

  function wire() {
    $('btn-add-class').addEventListener('click', startNew);
    $('class-list').addEventListener('click', function (e) {
      var row = e.target.closest('[data-id]');
      if (row) select(row.getAttribute('data-id'));
    });
    $('class-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
    $('class-name').addEventListener('change', function () {
      if (selectedId === 'new') draft.name = $('class-name').value; else commitName();
    });
    $('subject-options').addEventListener('click', function (e) {
      if (e.target.closest('#btn-new-subject')) {
        if (selectedId === 'new') draft.name = $('class-name').value;
        newSubjectOpen = true;
        renderPanel();
        $('new-subject-input').focus();
        return;
      }
      var b = e.target.closest('[data-subject]');
      if (b) chooseSubject(b.getAttribute('data-subject'));
    });
    $('new-subject-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); chooseSubject(e.target.value); }
    });
    $('btn-use-new-subject').addEventListener('click', function () { chooseSubject($('new-subject-input').value); });
    $('btn-create-class').addEventListener('click', addClass);
    $('btn-cancel-new').addEventListener('click', function () { selectedId = null; render(); });
    $('btn-delete-class').addEventListener('click', deleteClass);
  }

  root.Classes = {
    init: function (h) { host = h; wire(); },
    show: function () {
      showError('');
      clearPanelStatus();
      render();
    },
    leave: function () { return commitName(); }
  };
})(this);
