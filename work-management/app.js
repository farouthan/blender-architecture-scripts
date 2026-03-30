/**
 * ArchPlan AI — Core Application
 * Mobile-first PWA for qualitative architecture work management
 */

const App = (() => {
  // ── State ──────────────────────────────────────────────────────────

  let state = {
    projects: [],
    currentProjectId: null,
    currentTaskId: null,
    activeScreen: 'splash',
    taskFilter: 'all'
  };

  // ── Persistence ────────────────────────────────────────────────────

  function save() {
    try {
      localStorage.setItem('archplan-ai-state', JSON.stringify(state));
    } catch (e) {
      console.warn('Storage save failed:', e);
    }
  }

  function load() {
    try {
      const saved = localStorage.getItem('archplan-ai-state');
      if (saved) {
        const parsed = JSON.parse(saved);
        state.projects = parsed.projects || [];
        // Convert date strings back to timestamps
        state.projects.forEach(p => {
          if (typeof p.created === 'string') p.created = new Date(p.created).getTime();
          if (typeof p.targetDate === 'string') p.targetDate = new Date(p.targetDate).getTime();
          if (typeof p.phaseStartDate === 'string') p.phaseStartDate = new Date(p.phaseStartDate).getTime();
          (p.tasks || []).forEach(t => {
            if (typeof t.dueDate === 'string') t.dueDate = new Date(t.dueDate).getTime();
          });
        });
      }
    } catch (e) {
      console.warn('Storage load failed:', e);
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────

  function navigateTo(screenId) {
    const current = document.querySelector('.screen.active');
    const next = document.getElementById(`${screenId}-screen`);

    if (current && current !== next) {
      current.classList.add('exiting');
      current.classList.remove('active');
      setTimeout(() => current.classList.remove('exiting'), 400);
    }

    if (next) {
      requestAnimationFrame(() => {
        next.classList.add('active');
      });
    }

    state.activeScreen = screenId;
  }

  // ── Screen Renderers ──────────────────────────────────────────────

  function renderHome() {
    // Greeting
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('greeting').textContent = greet;

    const list = document.getElementById('project-list');
    const empty = document.getElementById('empty-state');

    if (state.projects.length === 0) {
      list.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    list.style.display = 'flex';
    empty.style.display = 'none';

    list.innerHTML = state.projects.map(p => {
      const tasks = p.tasks || [];
      const done = tasks.filter(t => t.status === 'done').length;
      const total = tasks.length;
      const progress = total > 0 ? Math.round((done / total) * 100) : 0;
      const phase = AIPlanner.ARCH_PHASES[p.phase];

      return `
        <div class="project-card" data-project-id="${p.id}">
          <div class="project-card-name">${escapeHtml(p.name)}</div>
          <div class="project-card-phase">${phase?.name || p.phase}</div>
          <div class="project-card-stats">
            <span class="project-stat"><strong>${done}</strong>/${total} tasks</span>
            <span class="project-stat"><strong>${progress}%</strong> complete</span>
            ${p.targetDate ? `<span class="project-stat">${formatDate(p.targetDate)}</span>` : ''}
          </div>
          <div class="project-card-bar" style="width:${progress}%"></div>
        </div>
      `;
    }).join('');
  }

  function renderProjectDetail() {
    const project = getCurrentProject();
    if (!project) return;

    document.getElementById('project-detail-title').textContent = project.name;
    renderTasks();
    renderInsights();
    renderWeeklyPlan();
  }

  function renderTasks() {
    const project = getCurrentProject();
    if (!project) return;

    let tasks = project.tasks || [];
    const filter = state.taskFilter;

    if (filter !== 'all') {
      tasks = tasks.filter(t => t.status === filter);
    }

    // AI prioritization
    tasks = AIPlanner.prioritizeTasks(tasks, project);

    const list = document.getElementById('task-list');
    if (tasks.length === 0) {
      list.innerHTML = `
        <div class="empty-state" style="padding:40px 20px;">
          <p>${filter === 'all' ? 'No tasks yet' : `No ${filter.replace('_', ' ')} tasks`}</p>
          <p class="empty-sub">${filter === 'all' ? 'Use the + button or generate AI tasks from the menu' : 'Try a different filter'}</p>
        </div>
      `;
      return;
    }

    list.innerHTML = tasks.map(t => {
      const isChecked = t.status === 'done';
      const isOverdue = t.dueDate && t.dueDate < Date.now() && !isChecked;

      return `
        <div class="task-card ${isChecked ? 'done' : ''}" data-task-id="${t.id}" data-priority="${t.priority || 'medium'}">
          <div class="task-checkbox ${isChecked ? 'checked' : ''}" data-task-toggle="${t.id}"></div>
          <div class="task-card-body">
            <div class="task-card-title">${escapeHtml(t.title)}</div>
            <div class="task-card-meta">
              ${t.aiGenerated ? '<span class="task-tag ai">AI</span>' : ''}
              ${(t.tags || []).slice(0, 2).map(tag => `<span class="task-tag">${tag}</span>`).join('')}
              ${t.dueDate ? `<span class="task-due ${isOverdue ? 'overdue' : ''}">${isOverdue ? 'Overdue: ' : ''}${formatDate(t.dueDate)}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderInsights() {
    const project = getCurrentProject();
    if (!project) return;

    const insights = AIPlanner.analyzeProjectHealth(project);
    const container = document.getElementById('insights-container');

    // Add phase context insight
    const phase = AIPlanner.ARCH_PHASES[project.phase];
    if (phase) {
      insights.unshift({
        type: 'info',
        title: `Current Phase: ${phase.name}`,
        message: phase.qualitativeTraits.join(' '),
        suggestion: null
      });
    }

    // If no issues found
    if (insights.length <= 1) {
      insights.push({
        type: 'success',
        title: 'Looking Good',
        message: 'No significant concerns detected. Keep the momentum going.',
        suggestion: 'Consider running a quick team check-in to surface any hidden blockers.'
      });
    }

    const icons = {
      warning: '!',
      caution: '~',
      reflection: '?',
      info: 'i',
      success: '\u2713'
    };

    container.innerHTML = insights.map(i => `
      <div class="insight-card ${i.type}">
        <div class="insight-header">
          <div class="insight-icon">${icons[i.type] || 'i'}</div>
          <div class="insight-title">${escapeHtml(i.title)}</div>
        </div>
        <div class="insight-message">${escapeHtml(i.message)}</div>
        ${i.suggestion ? `<div class="insight-suggestion">${escapeHtml(i.suggestion)}</div>` : ''}
      </div>
    `).join('');
  }

  function renderWeeklyPlan() {
    const project = getCurrentProject();
    if (!project) return;

    const plan = AIPlanner.generateWeeklyPlan(project);
    const container = document.getElementById('weekly-plan-container');

    let html = `
      <div class="plan-header">
        <div class="plan-week">Week of ${plan.weekOf}</div>
        <div class="plan-phase">${plan.phase}</div>
        <div class="plan-insight">${escapeHtml(plan.phaseInsight)}</div>
        ${plan.focusAreas.length > 0 ? `
          <div class="plan-focus">
            ${plan.focusAreas.map(f => `<span class="focus-tag">${f}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;

    if (plan.warnings.length > 0) {
      html += plan.warnings.map(w => `
        <div class="insight-card ${w.type}">
          <div class="insight-header">
            <div class="insight-icon">!</div>
            <div class="insight-title">${escapeHtml(w.title)}</div>
          </div>
          <div class="insight-message">${escapeHtml(w.message)}</div>
          ${w.suggestion ? `<div class="insight-suggestion">${escapeHtml(w.suggestion)}</div>` : ''}
        </div>
      `).join('');
    }

    if (plan.suggestedSequence.length > 0) {
      html += plan.suggestedSequence.map(day => `
        <div class="plan-day">
          <div class="plan-day-header">${day.day}</div>
          <div class="plan-day-tasks">
            ${day.tasks.map(t => `
              <div class="plan-task-item">
                <div class="plan-task-bullet"></div>
                ${escapeHtml(t.title)}
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');
    } else {
      html += `
        <div class="empty-state" style="padding:30px;">
          <p>No tasks to schedule</p>
          <p class="empty-sub">Add or generate tasks to see your weekly plan</p>
        </div>
      `;
    }

    html += `
      <div class="plan-reflection">
        <div class="plan-reflection-label">Weekly Reflection</div>
        <div class="plan-reflection-text">${escapeHtml(plan.reflection)}</div>
      </div>
    `;

    container.innerHTML = html;
  }

  function renderComplexity() {
    const project = getCurrentProject();
    if (!project) return;

    const complexity = AIPlanner.assessComplexity({
      siteType: project.siteType,
      programType: project.programType,
      teamType: project.teamType
    });

    const body = document.getElementById('complexity-body');
    const percent = Math.round(complexity.overall * 100);
    const circumference = 2 * Math.PI * 50;
    const offset = circumference - (complexity.overall * circumference);

    let color = '#22c55e';
    if (complexity.overall > 0.7) color = '#ef4444';
    else if (complexity.overall > 0.5) color = '#f59e0b';

    let html = `
      <div class="complexity-overall">
        <div class="complexity-meter">
          <svg viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="8"/>
            <circle cx="60" cy="60" r="50" fill="none" stroke="${color}" stroke-width="8"
              stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
              stroke-linecap="round" transform="rotate(-90 60 60)"
              style="transition: stroke-dashoffset 1s cubic-bezier(0.16,1,0.3,1);"/>
          </svg>
          <div class="complexity-meter-label">
            <div class="complexity-meter-value" style="color:${color}">${percent}%</div>
            <div class="complexity-meter-level">${complexity.level}</div>
          </div>
        </div>
        <div class="complexity-assessment">${escapeHtml(complexity.assessment)}</div>
      </div>
    `;

    html += complexity.factors.map(f => `
      <div class="complexity-factor">
        <div class="complexity-factor-header">
          <span class="complexity-factor-area">${f.area}</span>
          <span style="font-size:13px;color:var(--text-tertiary)">${Math.round(f.complexity * 100)}%</span>
        </div>
        <div class="complexity-factor-bar">
          <div class="complexity-factor-fill" style="width:${f.complexity * 100}%"></div>
        </div>
        <div class="complexity-factor-insight">${escapeHtml(f.insight)}</div>
      </div>
    `).join('');

    html += `
      <div class="complexity-recs">
        <h4>Recommendations</h4>
        <div class="complexity-rec-item">Schedule contingency: <strong>${complexity.recommendedContingency}</strong></div>
        <div class="complexity-rec-item">Buffer weeks: <strong>${complexity.recommendedBufferWeeks}</strong></div>
      </div>
    `;

    body.innerHTML = html;
  }

  function renderTaskDetail() {
    const project = getCurrentProject();
    const task = project?.tasks?.find(t => t.id === state.currentTaskId);
    if (!task) return;

    document.getElementById('task-title').value = task.title || '';
    document.getElementById('task-due-date').value = task.dueDate ? new Date(task.dueDate).toISOString().split('T')[0] : '';
    document.getElementById('task-notes').value = task.notes || '';
    document.getElementById('task-blocked-reason').value = task.blockedReason || '';

    // Status chips
    selectChip('task-status-chips', task.status || 'todo');
    document.getElementById('blocked-reason-group').style.display = task.status === 'blocked' ? 'block' : 'none';

    // Priority chips
    selectChip('task-priority-chips', task.priority || 'medium');

    // AI note
    const aiNote = document.getElementById('task-ai-note');
    const aiNoteText = document.getElementById('task-ai-note-text');
    if (task.qualitativeNote) {
      aiNote.style.display = 'block';
      aiNoteText.textContent = task.qualitativeNote;
    } else {
      aiNote.style.display = 'none';
    }

    // Delete button
    document.getElementById('btn-delete-task').style.display = task.id ? 'block' : 'none';
  }

  // ── New Project Form ──────────────────────────────────────────────

  function initNewProjectForm() {
    const selector = document.getElementById('phase-selector');
    selector.innerHTML = Object.entries(AIPlanner.ARCH_PHASES).map(([key, phase]) => `
      <div class="phase-option" data-phase="${key}">
        <div class="phase-dot"></div>
        <div>
          <div class="phase-option-name">${phase.name}</div>
        </div>
        <div class="phase-option-nature">${phase.nature}</div>
      </div>
    `).join('');
  }

  function getNewProjectData() {
    return {
      name: document.getElementById('project-name').value.trim(),
      siteType: getSelectedChip('site-type-chips'),
      programType: getSelectedChip('program-type-chips'),
      teamType: getSelectedChip('team-type-chips'),
      targetDate: document.getElementById('project-target-date').value,
      phase: document.querySelector('#phase-selector .phase-option.selected')?.dataset.phase
    };
  }

  function validateNewProject() {
    const data = getNewProjectData();
    const btn = document.getElementById('btn-create-project');
    btn.disabled = !(data.name && data.phase);
  }

  function createProject() {
    const data = getNewProjectData();
    const now = Date.now();

    const project = {
      id: `proj-${now}`,
      name: data.name,
      siteType: data.siteType,
      programType: data.programType,
      teamType: data.teamType,
      phase: data.phase,
      created: now,
      phaseStartDate: now,
      targetDate: data.targetDate ? new Date(data.targetDate).getTime() : null,
      tasks: []
    };

    // Generate AI tasks for the starting phase
    const aiTasks = AIPlanner.generatePhaseTasks(data.phase, {
      siteType: data.siteType,
      programType: data.programType,
      teamType: data.teamType
    });
    project.tasks = aiTasks;

    state.projects.push(project);
    save();

    // Navigate to the new project
    state.currentProjectId = project.id;
    renderProjectDetail();
    navigateTo('project');
  }

  // ── Task Operations ───────────────────────────────────────────────

  function toggleTask(taskId) {
    const project = getCurrentProject();
    const task = project?.tasks?.find(t => t.id === taskId);
    if (!task) return;

    task.status = task.status === 'done' ? 'todo' : 'done';
    save();
    renderTasks();
  }

  function openNewTask() {
    state.currentTaskId = null;
    document.getElementById('task-title').value = '';
    document.getElementById('task-due-date').value = '';
    document.getElementById('task-notes').value = '';
    document.getElementById('task-blocked-reason').value = '';
    selectChip('task-status-chips', 'todo');
    selectChip('task-priority-chips', 'medium');
    document.getElementById('blocked-reason-group').style.display = 'none';
    document.getElementById('task-ai-note').style.display = 'none';
    document.getElementById('btn-delete-task').style.display = 'none';
    navigateTo('task');
  }

  function openTaskDetail(taskId) {
    state.currentTaskId = taskId;
    renderTaskDetail();
    navigateTo('task');
  }

  function saveTask() {
    const project = getCurrentProject();
    if (!project) return;

    const title = document.getElementById('task-title').value.trim();
    if (!title) return;

    const taskData = {
      title,
      status: getSelectedChip('task-status-chips') || 'todo',
      priority: getSelectedChip('task-priority-chips') || 'medium',
      dueDate: document.getElementById('task-due-date').value ? new Date(document.getElementById('task-due-date').value).getTime() : null,
      notes: document.getElementById('task-notes').value.trim(),
      blockedReason: document.getElementById('task-blocked-reason').value.trim()
    };

    if (state.currentTaskId) {
      // Update existing
      const task = project.tasks.find(t => t.id === state.currentTaskId);
      if (task) Object.assign(task, taskData);
    } else {
      // Create new
      project.tasks.push({
        id: `task-${Date.now()}`,
        ...taskData,
        tags: ['manual'],
        aiGenerated: false,
        phase: project.phase
      });
    }

    save();
    renderProjectDetail();
    navigateTo('project');
  }

  function deleteTask() {
    const project = getCurrentProject();
    if (!project || !state.currentTaskId) return;

    project.tasks = project.tasks.filter(t => t.id !== state.currentTaskId);
    save();
    renderProjectDetail();
    navigateTo('project');
  }

  // ── Project Menu Actions ──────────────────────────────────────────

  function handleProjectAction(action) {
    hideModal();
    const project = getCurrentProject();
    if (!project) return;

    switch (action) {
      case 'complexity':
        renderComplexity();
        navigateTo('complexity');
        break;

      case 'generate-tasks': {
        const newTasks = AIPlanner.generatePhaseTasks(project.phase, {
          siteType: project.siteType,
          programType: project.programType,
          teamType: project.teamType
        });
        // Only add tasks that don't already exist by title
        const existingTitles = new Set(project.tasks.map(t => t.title));
        const unique = newTasks.filter(t => !existingTitles.has(t.title));
        project.tasks.push(...unique);
        save();
        renderProjectDetail();
        break;
      }

      case 'advance-phase': {
        const nextPhase = AIPlanner.getNextPhase(project.phase);
        if (nextPhase) {
          const nextKey = Object.entries(AIPlanner.ARCH_PHASES).find(([, v]) => v === nextPhase)?.[0];
          if (nextKey) {
            project.phase = nextKey;
            project.phaseStartDate = Date.now();
            save();
            renderProjectDetail();
          }
        }
        break;
      }

      case 'delete-project':
        state.projects = state.projects.filter(p => p.id !== project.id);
        save();
        renderHome();
        navigateTo('home');
        break;

      case 'cancel':
        break;
    }
  }

  // ── Modal ─────────────────────────────────────────────────────────

  function showModal(id) {
    document.getElementById(id).style.display = 'block';
  }

  function hideModal() {
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  }

  // ── Chip Helpers ──────────────────────────────────────────────────

  function selectChip(groupId, value) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.chip').forEach(c => {
      c.classList.toggle('selected', c.dataset.value === value);
    });
  }

  function getSelectedChip(groupId) {
    const group = document.getElementById(groupId);
    return group?.querySelector('.chip.selected')?.dataset.value || null;
  }

  // ── Utilities ─────────────────────────────────────────────────────

  function getCurrentProject() {
    return state.projects.find(p => p.id === state.currentProjectId);
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(timestamp) {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
  }

  // ── Event Binding ─────────────────────────────────────────────────

  function init() {
    load();

    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    initNewProjectForm();

    // Splash
    document.getElementById('btn-get-started').addEventListener('click', () => {
      renderHome();
      navigateTo('home');
    });

    // If returning user, skip splash
    if (state.projects.length > 0) {
      renderHome();
      navigateTo('home');
    }

    // New project button
    document.getElementById('btn-new-project').addEventListener('click', () => {
      // Reset form
      document.getElementById('project-name').value = '';
      document.getElementById('project-target-date').value = '';
      document.querySelectorAll('#new-project-screen .chip').forEach(c => c.classList.remove('selected'));
      document.querySelectorAll('#phase-selector .phase-option').forEach(c => c.classList.remove('selected'));
      document.getElementById('btn-create-project').disabled = true;
      navigateTo('new-project');
    });

    // Chip selection (event delegation)
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) {
        const group = chip.closest('.chip-group');
        if (group) {
          group.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
          chip.classList.add('selected');
          validateNewProject();
        }
      }

      // Phase selector
      const phaseOpt = e.target.closest('.phase-option');
      if (phaseOpt) {
        document.querySelectorAll('.phase-option').forEach(p => p.classList.remove('selected'));
        phaseOpt.classList.add('selected');
        validateNewProject();
      }

      // Back buttons
      const backBtn = e.target.closest('.btn-back');
      if (backBtn) {
        const target = backBtn.dataset.back;
        if (target === 'home') renderHome();
        if (target === 'project') renderProjectDetail();
        navigateTo(target);
      }

      // Project cards
      const projectCard = e.target.closest('.project-card');
      if (projectCard && !e.target.closest('.btn-back')) {
        state.currentProjectId = projectCard.dataset.projectId;
        renderProjectDetail();
        navigateTo('project');
      }

      // Task toggle
      const toggle = e.target.closest('[data-task-toggle]');
      if (toggle) {
        e.stopPropagation();
        toggleTask(toggle.dataset.taskToggle);
        return;
      }

      // Task card click (open detail)
      const taskCard = e.target.closest('.task-card');
      if (taskCard) {
        openTaskDetail(taskCard.dataset.taskId);
      }

      // Tab switching
      const tab = e.target.closest('.tab');
      if (tab) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = document.getElementById(`tab-${tab.dataset.tab}`);
        if (target) target.classList.add('active');
      }

      // Task filter
      const filterChip = e.target.closest('.filter-chip');
      if (filterChip) {
        document.querySelectorAll('.filter-chip').forEach(f => f.classList.remove('active'));
        filterChip.classList.add('active');
        state.taskFilter = filterChip.dataset.filter;
        renderTasks();
      }

      // Modal backdrop
      if (e.target.closest('.modal-backdrop')) {
        hideModal();
      }

      // Modal options
      const modalOpt = e.target.closest('.modal-option');
      if (modalOpt) {
        handleProjectAction(modalOpt.dataset.action);
      }
    });

    // Create project
    document.getElementById('btn-create-project').addEventListener('click', createProject);

    // Project name validation
    document.getElementById('project-name').addEventListener('input', validateNewProject);

    // Project menu
    document.getElementById('btn-project-menu').addEventListener('click', () => {
      showModal('project-menu-modal');
    });

    // Task status change shows/hides blocked reason
    document.getElementById('task-status-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) {
        document.getElementById('blocked-reason-group').style.display =
          chip.dataset.value === 'blocked' ? 'block' : 'none';
      }
    });

    // Add task FAB
    document.getElementById('btn-add-task').addEventListener('click', openNewTask);

    // Save task
    document.getElementById('btn-save-task').addEventListener('click', saveTask);

    // Delete task
    document.getElementById('btn-delete-task').addEventListener('click', deleteTask);

    // Handle hash navigation
    if (window.location.hash === '#new-project') {
      navigateTo('new-project');
    } else if (window.location.hash === '#insights' && state.projects.length > 0) {
      state.currentProjectId = state.projects[0].id;
      renderProjectDetail();
      navigateTo('project');
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { state, navigateTo };
})();
