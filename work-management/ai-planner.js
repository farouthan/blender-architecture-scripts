/**
 * ArchPlan AI — Qualitative AI Planning Engine
 *
 * This engine provides qualitative (not just quantitative) intelligence:
 * - Understands architecture project phases and their nature
 * - Assesses risk through contextual pattern recognition
 * - Provides narrative insights, not just numbers
 * - Adapts recommendations to project personality and team dynamics
 * - Identifies hidden dependencies and emotional/creative bottlenecks
 */

const AIPlanner = (() => {

  // ── Architecture Domain Knowledge ──────────────────────────────────

  const ARCH_PHASES = {
    concept: {
      name: 'Concept & Brief',
      nature: 'exploratory',
      typicalWeight: 0.10,
      qualitativeTraits: [
        'High ambiguity is normal and healthy at this stage',
        'Client vision may shift — embrace fluidity',
        'Early constraints shape everything downstream'
      ],
      riskPatterns: [
        { signal: 'scope_undefined', insight: 'Without a clear brief, downstream phases will compound uncertainty. Consider a structured workshop.' },
        { signal: 'stakeholder_misalignment', insight: 'Divergent stakeholder visions now become costly conflicts later. Facilitate alignment before proceeding.' }
      ],
      suggestedActivities: [
        'Site visit and contextual analysis',
        'Client vision workshop',
        'Precedent study and mood boards',
        'Initial budget framing',
        'Regulatory pre-check'
      ]
    },
    schematic: {
      name: 'Schematic Design',
      nature: 'creative-structured',
      typicalWeight: 0.15,
      qualitativeTraits: [
        'Balance between creative exploration and practical constraints',
        'Key spatial relationships are established here',
        'This phase defines the project identity'
      ],
      riskPatterns: [
        { signal: 'too_many_options', insight: 'Decision paralysis detected. Narrow to 2-3 strong options and evaluate against the brief.' },
        { signal: 'no_structural_input', insight: 'Structural feasibility should be checked now — beautiful designs that can\'t stand up waste everyone\'s time.' }
      ],
      suggestedActivities: [
        'Massing studies and spatial diagrams',
        'Structural concept coordination',
        'Preliminary material palette',
        'Energy strategy outline',
        'Client presentation and feedback'
      ]
    },
    design_development: {
      name: 'Design Development',
      nature: 'refinement',
      typicalWeight: 0.20,
      qualitativeTraits: [
        'Details matter now — every decision has cost implications',
        'Consultant coordination becomes critical',
        'This is where quality is built or compromised'
      ],
      riskPatterns: [
        { signal: 'consultant_lag', insight: 'Waiting on consultant input creates cascading delays. Proactively schedule coordination meetings.' },
        { signal: 'budget_drift', insight: 'Design ambitions are outpacing budget. Have an honest conversation now rather than painful value-engineering later.' },
        { signal: 'detail_overload', insight: 'Perfectionism at this stage can stall progress. Focus on decisions that lock in geometry and systems.' }
      ],
      suggestedActivities: [
        'Detailed floor plans and sections',
        'Material and finish selections',
        'MEP coordination',
        'Code compliance review',
        'Updated cost estimate'
      ]
    },
    documentation: {
      name: 'Construction Documentation',
      nature: 'production',
      typicalWeight: 0.25,
      qualitativeTraits: [
        'Precision and completeness are paramount',
        'Errors here become expensive on site',
        'Team endurance matters — this is a marathon phase'
      ],
      riskPatterns: [
        { signal: 'incomplete_details', insight: 'Gaps in documentation lead to RFIs and change orders. Systematic completeness checks are essential.' },
        { signal: 'team_fatigue', insight: 'Documentation burnout is real. Consider rotating tasks or building in creative breaks to maintain quality.' },
        { signal: 'late_changes', insight: 'Design changes during documentation are 5-10x more expensive to process. Establish a formal change control process.' }
      ],
      suggestedActivities: [
        'Construction drawing sets',
        'Specifications writing',
        'Detail development',
        'Permit submission',
        'Contractor pre-qualification'
      ]
    },
    procurement: {
      name: 'Procurement & Bidding',
      nature: 'transactional',
      typicalWeight: 0.08,
      qualitativeTraits: [
        'Market conditions heavily influence outcomes',
        'Clarity of documents directly affects bid quality',
        'Relationship with contractors matters more than lowest price'
      ],
      riskPatterns: [
        { signal: 'single_bidder', insight: 'Limited competition reduces negotiating leverage and increases risk. Cast a wider net.' },
        { signal: 'wide_bid_spread', insight: 'Large variance in bids suggests ambiguity in documents. Review scope clarity before awarding.' }
      ],
      suggestedActivities: [
        'Bid package preparation',
        'Pre-bid meeting',
        'Bid evaluation and comparison',
        'Contract negotiation',
        'Award recommendation'
      ]
    },
    construction: {
      name: 'Construction Administration',
      nature: 'oversight',
      typicalWeight: 0.18,
      qualitativeTraits: [
        'The design meets reality — expect surprises',
        'Responsiveness to RFIs directly affects schedule',
        'Quality of site observation prevents costly rework'
      ],
      riskPatterns: [
        { signal: 'rfi_volume_high', insight: 'Excessive RFIs may indicate documentation gaps or contractor unfamiliarity. Consider on-site clarification sessions.' },
        { signal: 'substitution_requests', insight: 'Material substitutions can erode design intent. Evaluate each against the project\'s qualitative goals, not just specs.' }
      ],
      suggestedActivities: [
        'Submittal reviews',
        'RFI responses',
        'Site observation visits',
        'Change order review',
        'Progress documentation'
      ]
    },
    closeout: {
      name: 'Project Closeout',
      nature: 'completion',
      typicalWeight: 0.04,
      qualitativeTraits: [
        'Attention to punch list items defines the final impression',
        'Knowledge capture is invaluable for future projects',
        'Client handoff is a relationship moment, not just paperwork'
      ],
      riskPatterns: [
        { signal: 'punch_list_growing', insight: 'An expanding punch list signals contractor disengagement. Escalate and set firm completion milestones.' },
        { signal: 'missing_closeout_docs', insight: 'Incomplete warranties, manuals, and as-builts create long-term liability. Don\'t release final payment without them.' }
      ],
      suggestedActivities: [
        'Substantial completion inspection',
        'Punch list development and tracking',
        'Closeout document collection',
        'Post-occupancy evaluation planning',
        'Project retrospective'
      ]
    }
  };

  // ── Qualitative Assessment Models ──────────────────────────────────

  const COMPLEXITY_FACTORS = {
    site: {
      urban_infill: { complexity: 0.85, insight: 'Urban infill projects carry hidden complexity — neighboring structures, utilities, access constraints, and community sensitivity.' },
      greenfield: { complexity: 0.3, insight: 'Greenfield offers freedom but demands thorough site analysis — what seems simple often has subsurface or environmental surprises.' },
      renovation: { complexity: 0.9, insight: 'Renovation complexity is often underestimated. Existing conditions documentation is never complete — budget for discovery.' },
      adaptive_reuse: { complexity: 0.95, insight: 'Adaptive reuse is intellectually rewarding but operationally demanding. The existing building will fight you at every turn.' },
      suburban: { complexity: 0.4, insight: 'Suburban sites are typically straightforward but check HOA restrictions and utility availability early.' }
    },
    program: {
      residential_single: { complexity: 0.3, insight: 'Single residential is manageable but deeply personal. Client emotional investment is highest here.' },
      residential_multi: { complexity: 0.6, insight: 'Multi-residential multiplies every decision. Unit type standardization is your friend.' },
      commercial: { complexity: 0.5, insight: 'Commercial projects are driven by ROI. Every design decision must justify its cost impact.' },
      institutional: { complexity: 0.7, insight: 'Institutional projects involve many stakeholders and long approval chains. Build patience into your schedule.' },
      mixed_use: { complexity: 0.85, insight: 'Mixed-use is essentially multiple projects sharing structure. Interface management is the hidden challenge.' },
      healthcare: { complexity: 0.95, insight: 'Healthcare demands extreme coordination — regulatory, infection control, equipment planning. Specialist consultants are essential.' }
    },
    team: {
      solo: { complexity: 0.5, insight: 'Solo practice means flexibility but vulnerability. Your bottleneck is yourself — plan for rest.' },
      small_team: { complexity: 0.4, insight: 'Small teams thrive on communication. Keep meetings short and decisions documented.' },
      multi_office: { complexity: 0.7, insight: 'Multi-office coordination requires deliberate communication rituals. What\'s obvious in one office is unknown in another.' },
      joint_venture: { complexity: 0.85, insight: 'JV structures need clear responsibility matrices from day one. Ambiguous ownership kills projects.' }
    }
  };

  // ── Qualitative AI Analysis Functions ──────────────────────────────

  function analyzeProjectHealth(project) {
    const insights = [];
    const tasks = project.tasks || [];
    const now = Date.now();

    // Phase progression analysis
    const currentPhase = ARCH_PHASES[project.phase];
    if (currentPhase) {
      const phaseStart = project.phaseStartDate || project.created;
      const totalDuration = project.targetDate ? project.targetDate - project.created : null;
      if (totalDuration) {
        const expectedPhaseDuration = totalDuration * currentPhase.typicalWeight;
        const actualPhaseDuration = now - phaseStart;
        const phaseRatio = actualPhaseDuration / expectedPhaseDuration;

        if (phaseRatio > 1.3) {
          insights.push({
            type: 'warning',
            category: 'pace',
            title: 'Phase Duration Concern',
            message: `${currentPhase.name} is running ${Math.round((phaseRatio - 1) * 100)}% longer than typical. ${currentPhase.qualitativeTraits[0]}`,
            actionable: true,
            suggestion: 'Review open items and identify what\'s blocking progression to the next phase.'
          });
        } else if (phaseRatio < 0.5 && tasks.filter(t => t.status === 'done').length < tasks.length * 0.7) {
          insights.push({
            type: 'caution',
            category: 'quality',
            title: 'Rushing Risk',
            message: `You\'re moving through ${currentPhase.name} quickly with many tasks incomplete. Speed without thoroughness here creates problems in ${getNextPhase(project.phase)?.name || 'later phases'}.`,
            actionable: true,
            suggestion: 'Verify that key deliverables meet quality standards before advancing.'
          });
        }
      }
    }

    // Task health patterns
    const overdueTasks = tasks.filter(t => t.dueDate && t.dueDate < now && t.status !== 'done');
    const blockedTasks = tasks.filter(t => t.status === 'blocked');
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress');

    if (overdueTasks.length > tasks.length * 0.3 && tasks.length > 3) {
      insights.push({
        type: 'warning',
        category: 'planning',
        title: 'Systemic Delay Pattern',
        message: 'More than 30% of tasks are overdue. This usually indicates the schedule was optimistic rather than individual task failures.',
        actionable: true,
        suggestion: 'Rebaseline the schedule with realistic durations. It\'s better to reset expectations than to accumulate silent delays.'
      });
    }

    if (inProgressTasks.length > 5) {
      insights.push({
        type: 'caution',
        category: 'focus',
        title: 'Work-in-Progress Overload',
        message: `${inProgressTasks.length} tasks are in progress simultaneously. Context-switching degrades quality — especially in detail-oriented architecture work.`,
        actionable: true,
        suggestion: 'Limit work-in-progress to 3-4 items. Finish before starting.'
      });
    }

    if (blockedTasks.length > 0) {
      const blockedInsight = analyzeBlockers(blockedTasks, project);
      insights.push(blockedInsight);
    }

    // Creative energy assessment
    const creativeTasks = tasks.filter(t => t.tags?.includes('creative') || t.tags?.includes('design'));
    const adminTasks = tasks.filter(t => t.tags?.includes('admin') || t.tags?.includes('coordination'));
    if (creativeTasks.length > 0 && adminTasks.length > creativeTasks.length * 3) {
      insights.push({
        type: 'reflection',
        category: 'balance',
        title: 'Creative-Administrative Balance',
        message: 'Administrative tasks heavily outweigh creative work. Architecture thrives on design thinking — ensure the team has space for it.',
        actionable: false,
        suggestion: 'Block dedicated design time that\'s protected from meetings and admin.'
      });
    }

    return insights;
  }

  function analyzeBlockers(blockedTasks, project) {
    const blockerTypes = {};
    blockedTasks.forEach(t => {
      const reason = t.blockedReason || 'unspecified';
      blockerTypes[reason] = (blockerTypes[reason] || 0) + 1;
    });

    const topBlocker = Object.entries(blockerTypes).sort((a, b) => b[1] - a[1])[0];
    const phase = ARCH_PHASES[project.phase];

    // Check if blocker matches known risk patterns
    let patternMatch = null;
    if (phase) {
      patternMatch = phase.riskPatterns.find(rp => {
        const signal = rp.signal.toLowerCase();
        return topBlocker[0].toLowerCase().includes(signal.replace(/_/g, ' ')) ||
               signal.includes(topBlocker[0].toLowerCase().replace(/\s/g, '_'));
      });
    }

    return {
      type: 'warning',
      category: 'blockers',
      title: `Blocked: ${blockedTasks.length} Task${blockedTasks.length > 1 ? 's' : ''}`,
      message: patternMatch
        ? patternMatch.insight
        : `Primary blocker: "${topBlocker[0]}" (${topBlocker[1]} tasks). Unresolved blockers compound — each day adds pressure to downstream work.`,
      actionable: true,
      suggestion: 'Schedule a dedicated unblocking session. Assign one person to own blocker resolution.'
    };
  }

  function getNextPhase(currentPhaseKey) {
    const keys = Object.keys(ARCH_PHASES);
    const idx = keys.indexOf(currentPhaseKey);
    return idx >= 0 && idx < keys.length - 1 ? ARCH_PHASES[keys[idx + 1]] : null;
  }

  // ── Smart Task Generation ──────────────────────────────────────────

  function generatePhaseTasks(phaseKey, projectContext) {
    const phase = ARCH_PHASES[phaseKey];
    if (!phase) return [];

    const tasks = phase.suggestedActivities.map((activity, i) => ({
      id: `ai-${phaseKey}-${i}-${Date.now()}`,
      title: activity,
      phase: phaseKey,
      status: 'todo',
      priority: i < 2 ? 'high' : i < 4 ? 'medium' : 'low',
      tags: inferTags(activity),
      aiGenerated: true,
      estimatedEffort: estimateEffort(activity, projectContext),
      qualitativeNote: generateTaskNote(activity, phaseKey, projectContext)
    }));

    // Add context-specific tasks
    if (projectContext) {
      const contextTasks = generateContextualTasks(phaseKey, projectContext);
      tasks.push(...contextTasks);
    }

    return tasks;
  }

  function inferTags(activity) {
    const tagMap = {
      creative: ['study', 'design', 'massing', 'concept', 'mood', 'palette', 'diagram'],
      coordination: ['coordination', 'meeting', 'consultant', 'MEP', 'structural'],
      admin: ['permit', 'submission', 'contract', 'bid', 'qualification', 'compliance'],
      review: ['review', 'evaluation', 'inspection', 'observation', 'assessment'],
      client: ['client', 'presentation', 'feedback', 'handoff', 'workshop'],
      documentation: ['drawing', 'specification', 'document', 'plan', 'section', 'detail']
    };

    const tags = [];
    const lower = activity.toLowerCase();
    for (const [tag, keywords] of Object.entries(tagMap)) {
      if (keywords.some(kw => lower.includes(kw))) {
        tags.push(tag);
      }
    }
    return tags.length > 0 ? tags : ['general'];
  }

  function estimateEffort(activity, context) {
    const lower = activity.toLowerCase();
    let baseEffort = 'medium'; // days

    if (lower.includes('drawing') || lower.includes('specification') || lower.includes('construction')) {
      baseEffort = 'high';
    } else if (lower.includes('meeting') || lower.includes('visit') || lower.includes('pre-check')) {
      baseEffort = 'low';
    }

    // Adjust for complexity
    if (context?.siteType) {
      const siteComplexity = COMPLEXITY_FACTORS.site[context.siteType]?.complexity || 0.5;
      if (siteComplexity > 0.7 && baseEffort === 'medium') baseEffort = 'high';
    }

    return baseEffort;
  }

  function generateTaskNote(activity, phaseKey, context) {
    const phase = ARCH_PHASES[phaseKey];
    const lower = activity.toLowerCase();

    if (lower.includes('client')) {
      return 'Client-facing work sets the tone. Prepare thoroughly — first impressions of design intent are lasting.';
    }
    if (lower.includes('cost') || lower.includes('budget')) {
      return 'Cost conversations are design conversations. Frame budget as a creative constraint, not a limitation.';
    }
    if (lower.includes('coordination')) {
      return 'Good coordination is invisible. Poor coordination is expensive. Document all decisions made in coordination meetings.';
    }
    if (lower.includes('review') || lower.includes('compliance')) {
      return 'Reviews catch issues when they\'re cheap to fix. Approach them as quality investments, not bureaucratic hurdles.';
    }
    if (lower.includes('site')) {
      return 'The site always has something to teach. Go with fresh eyes and a camera — digital drawings never tell the whole story.';
    }

    return phase.qualitativeTraits[Math.floor(Math.random() * phase.qualitativeTraits.length)];
  }

  function generateContextualTasks(phaseKey, context) {
    const tasks = [];

    if (context.siteType === 'renovation' || context.siteType === 'adaptive_reuse') {
      if (phaseKey === 'concept' || phaseKey === 'schematic') {
        tasks.push({
          id: `ai-ctx-${Date.now()}-1`,
          title: 'Existing conditions survey and documentation',
          phase: phaseKey,
          status: 'todo',
          priority: 'high',
          tags: ['documentation', 'critical'],
          aiGenerated: true,
          estimatedEffort: 'high',
          qualitativeNote: 'For renovation/adaptive reuse, existing conditions documentation is your foundation. Invest heavily here — every undocumented condition becomes a change order later.'
        });
      }
    }

    if (context.programType === 'healthcare') {
      tasks.push({
        id: `ai-ctx-${Date.now()}-2`,
        title: 'Healthcare regulatory compliance review',
        phase: phaseKey,
        status: 'todo',
        priority: 'high',
        tags: ['admin', 'compliance', 'critical'],
        aiGenerated: true,
        estimatedEffort: 'high',
        qualitativeNote: 'Healthcare regulations are non-negotiable and phase-specific. Engage your code consultant early and often.'
      });
    }

    if (context.teamType === 'joint_venture' && (phaseKey === 'concept' || phaseKey === 'schematic')) {
      tasks.push({
        id: `ai-ctx-${Date.now()}-3`,
        title: 'Establish JV responsibility matrix and communication protocol',
        phase: phaseKey,
        status: 'todo',
        priority: 'high',
        tags: ['coordination', 'critical'],
        aiGenerated: true,
        estimatedEffort: 'medium',
        qualitativeNote: 'Joint ventures fail at the seams. Define who owns what before the work begins, and revisit monthly.'
      });
    }

    return tasks;
  }

  // ── Qualitative Priority Intelligence ──────────────────────────────

  function prioritizeTasks(tasks, project) {
    return tasks.map(task => {
      let score = 0;
      let reasoning = [];

      // Urgency from due date
      if (task.dueDate) {
        const daysUntilDue = (task.dueDate - Date.now()) / (1000 * 60 * 60 * 24);
        if (daysUntilDue < 0) {
          score += 40;
          reasoning.push('Overdue — immediate attention needed');
        } else if (daysUntilDue < 3) {
          score += 30;
          reasoning.push('Due very soon');
        } else if (daysUntilDue < 7) {
          score += 15;
          reasoning.push('Due this week');
        }
      }

      // Blocking impact
      const blocksOthers = tasks.filter(t => t.dependencies?.includes(task.id));
      if (blocksOthers.length > 0) {
        score += blocksOthers.length * 10;
        reasoning.push(`Unblocks ${blocksOthers.length} other task${blocksOthers.length > 1 ? 's' : ''}`);
      }

      // Phase alignment
      if (task.phase === project.phase) {
        score += 15;
        reasoning.push('Aligned with current phase');
      }

      // Critical path
      if (task.tags?.includes('critical')) {
        score += 20;
        reasoning.push('On critical path');
      }

      // Client-facing work gets priority
      if (task.tags?.includes('client')) {
        score += 10;
        reasoning.push('Client-facing — affects relationship');
      }

      // Explicit priority
      if (task.priority === 'high') score += 15;
      else if (task.priority === 'medium') score += 8;

      return {
        ...task,
        aiPriorityScore: score,
        aiPriorityReasoning: reasoning.length > 0 ? reasoning : ['Standard priority']
      };
    }).sort((a, b) => b.aiPriorityScore - a.aiPriorityScore);
  }

  // ── Weekly Planning Intelligence ───────────────────────────────────

  function generateWeeklyPlan(project) {
    const tasks = project.tasks || [];
    const phase = ARCH_PHASES[project.phase];
    const prioritized = prioritizeTasks(tasks.filter(t => t.status !== 'done'), project);

    const plan = {
      weekOf: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      phase: phase?.name || 'Unknown',
      phaseInsight: phase?.qualitativeTraits[0] || '',
      focusAreas: [],
      suggestedSequence: [],
      warnings: [],
      reflection: ''
    };

    // Identify focus areas
    const tagCounts = {};
    prioritized.slice(0, 8).forEach(t => {
      (t.tags || []).forEach(tag => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    });
    plan.focusAreas = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag]) => tag);

    // Build daily suggestions (5 work days)
    const available = [...prioritized];
    for (let day = 0; day < 5 && available.length > 0; day++) {
      const dayName = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][day];
      const dayTasks = [];

      // Assign 2-3 tasks per day based on effort
      let dayLoad = 0;
      const maxLoad = 3;
      while (dayLoad < maxLoad && available.length > 0) {
        const task = available.shift();
        const effort = task.estimatedEffort === 'high' ? 2 : task.estimatedEffort === 'medium' ? 1 : 0.5;
        if (dayLoad + effort <= maxLoad) {
          dayTasks.push(task);
          dayLoad += effort;
        } else {
          available.unshift(task);
          break;
        }
      }

      if (dayTasks.length > 0) {
        plan.suggestedSequence.push({ day: dayName, tasks: dayTasks });
      }
    }

    // Add qualitative warnings
    const healthInsights = analyzeProjectHealth(project);
    plan.warnings = healthInsights.filter(i => i.type === 'warning' || i.type === 'caution');

    // Weekly reflection prompt
    const reflections = [
      'What decision this week will have the biggest downstream impact?',
      'Is there something you\'re avoiding that needs attention?',
      'Which stakeholder relationship needs the most care right now?',
      'What\'s the one thing that could derail next week if not addressed now?',
      'Are you designing for the building\'s occupants or just its owners?'
    ];
    plan.reflection = reflections[Math.floor(Math.random() * reflections.length)];

    return plan;
  }

  // ── Project Complexity Assessment ──────────────────────────────────

  function assessComplexity(projectContext) {
    const factors = [];
    let totalComplexity = 0;
    let count = 0;

    if (projectContext.siteType && COMPLEXITY_FACTORS.site[projectContext.siteType]) {
      const factor = COMPLEXITY_FACTORS.site[projectContext.siteType];
      factors.push({ area: 'Site', ...factor });
      totalComplexity += factor.complexity;
      count++;
    }

    if (projectContext.programType && COMPLEXITY_FACTORS.program[projectContext.programType]) {
      const factor = COMPLEXITY_FACTORS.program[projectContext.programType];
      factors.push({ area: 'Program', ...factor });
      totalComplexity += factor.complexity;
      count++;
    }

    if (projectContext.teamType && COMPLEXITY_FACTORS.team[projectContext.teamType]) {
      const factor = COMPLEXITY_FACTORS.team[projectContext.teamType];
      factors.push({ area: 'Team', ...factor });
      totalComplexity += factor.complexity;
      count++;
    }

    const avgComplexity = count > 0 ? totalComplexity / count : 0.5;

    let overallAssessment;
    if (avgComplexity > 0.8) {
      overallAssessment = 'This is a demanding project that requires experienced leadership, robust processes, and generous contingencies. Plan for the unexpected — it will come.';
    } else if (avgComplexity > 0.6) {
      overallAssessment = 'Moderate-to-high complexity. Success depends on disciplined coordination and proactive risk management. Don\'t let the manageable parts lull you into complacency about the challenging ones.';
    } else if (avgComplexity > 0.4) {
      overallAssessment = 'Manageable complexity. This is an opportunity to deliver excellent quality within clear constraints. Focus on doing the fundamentals exceptionally well.';
    } else {
      overallAssessment = 'Relatively straightforward project. Use this as an opportunity to invest in process improvement and team development alongside delivery.';
    }

    return {
      overall: avgComplexity,
      level: avgComplexity > 0.8 ? 'high' : avgComplexity > 0.5 ? 'moderate' : 'manageable',
      factors,
      assessment: overallAssessment,
      recommendedContingency: `${Math.round(avgComplexity * 25 + 5)}%`,
      recommendedBufferWeeks: Math.ceil(avgComplexity * 4)
    };
  }

  // ── Public API ─────────────────────────────────────────────────────

  return {
    ARCH_PHASES,
    COMPLEXITY_FACTORS,
    analyzeProjectHealth,
    generatePhaseTasks,
    prioritizeTasks,
    generateWeeklyPlan,
    assessComplexity,
    getNextPhase
  };

})();

if (typeof module !== 'undefined') module.exports = AIPlanner;
