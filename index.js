// Slow Plot — gradual story-arc director for SillyTavern.
// UI text is Korean; every prompt the model reads is English.

const MODULE = 'slow_plot';
const LOG = '[Slow Plot]';

// Mirrors of ST's extension_prompt_types / extension_prompt_roles (script.js)
const PROMPT_IN_CHAT = 1;
const PROMPT_NONE = -1;
const ROLES = { system: 0, user: 1, assistant: 2 };

const defaultSettings = Object.freeze({
    enabled: true,
    judgeInterval: 5,    // check every N bot replies
    minRatio: 0.7,       // never advance before this share of the stage's budget
    depth: 4,            // injection depth in chat
    role: 'system',
    judgeWindow: 20,     // how many recent messages the judge reads
    stageToast: true,    // toast when the story moves to another stage on its own
    hideStages: false,   // keep stages that are not done yet hidden (spoiler guard)
    profileId: '',       // connection profile for planning/judging; '' = current connection
    prompts: {},         // user overrides of DEFAULT_PROMPTS, keyed by prompt id
});

const PRESETS = {
    tropes: ['계약 관계', '정략결혼', '기억상실', '신분 차이', '회귀', '재회', '시한부', '오해', '비밀 정체', '삼각관계', '복수', '동거', '구원', '라이벌', '럭키 스케베'],
    mood: ['피폐', '애틋', '달달', '로코', '긴장감', '미스터리', '일상', '코믹', '성장', '구원', '집착', '뽕빨'],
    length: [30, 50, 100, 200, 400, 800],
    stages: ['auto', 3, 4, 5, 6, 7, 8],
};

// ---------- settings / state ----------

function ctx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE], k)) extensionSettings[MODULE][k] = structuredClone(defaultSettings[k]);
    }
    return extensionSettings[MODULE];
}

function newArc() {
    return {
        setup: {
            plot: '',         // the story the user wants, free text
            ending: '',       // optional: where it should end up
            moods: [], moodCustom: '', moodCustomOn: false,
            memo: '',
            length: 100, lengthCustom: false,
            stageCount: 'auto',
            stageCustom: false,
            ideaKeywords: '',
            ideaSpice: 'mid',  // calm | mid | wild
            ideaUseChat: true,
            ideaTropes: [],
            ideaEnding: 'any',  // any | happy | sad | open | twist
            ideaAvoid: '',
            ideaFocus: 'both',  // both | char | user | ensemble
            planUseChat: true,
            useSummary: true,    // read what summary extensions currently inject
            castExtra: '',      // extra character names for multi-character bots (comma separated)
            chatCount: 30,     // how many recent messages planning/ideas read
            difficulty: 'normal', // easy | normal | hard | hell
            obstacles: false,
            obstacleText: '',
            innerHint: false,
            foreshadow: false,
            breather: false,
            breatherEvery: 5,
            autoEvent: false,
            useChar: true,
            usePersona: true,
            wi: {},           // { bookName: [uid, ...] } entries sent when planning
            wiBook: '',       // book currently shown in the picker
        },
        arcEn: null,          // { from, to, tone, notes } in English
        stages: [],           // { title_ko, summary_ko, title_en, guide_en }
        status: 'setup',      // setup | draft | running | paused | done
        current: 0,
        base: 0,              // message count when the arc started
        stageStarts: [],      // progress value at each stage's start
        lastJudge: 0,
        hold: false,          // stay mode: keep injecting the current chapter but never advance
        frozenAt: null,       // bot-reply count when paused/held; replies meanwhile are not counted
        countMode: 'idx',     // progress = bot replies after chat index baseIndex
        baseIndex: null,
        eventPending: false,  // a surprise event goes into the next reply
        nudgePending: false,  // one firmer push in the next reply
        ideas: [],            // last story suggestions: { title, story, ending, moods[] }
        inner: null,          // { text, warmth, at } — char's hidden feelings, for the hint box
        log: [],
        prefsOn: true,        // taste points on for this chat
        prefs: [],            // taste points: { id, text, label, aware, surface, avoid, freq, on, failed }
    };
}

function hasChat() {
    return !!ctx().getCurrentChatId();
}

function getArc() {
    if (!hasChat()) return null;
    const { chatMetadata } = ctx();
    if (!chatMetadata[MODULE]) chatMetadata[MODULE] = newArc();
    const arc = chatMetadata[MODULE];
    migrateCounting(arc);
    const fresh = newArc();
    for (const k of Object.keys(fresh)) if (!Object.hasOwn(arc, k)) arc[k] = fresh[k];
    for (const k of Object.keys(fresh.setup)) if (!Object.hasOwn(arc.setup, k)) arc.setup[k] = fresh.setup[k];
    return arc;
}

function save() {
    ctx().saveMetadataDebounced();
}

// ---------- counting / pacing ----------

// Pacing counts only the bot's replies: user inputs vary too much in size to be a fair clock.
function messageCount() {
    return ctx().chat.filter(m => isBotReply(m)).length;
}

// Hidden messages (/hide, or summary extensions that hide old turns) are flagged is_system
// but are still real replies; genuine system notes carry extra.type (narrator, comment, ...).
function isRealSystem(m) {
    return !!m?.is_system && !!m?.extra?.type;
}

function isBotReply(m) {
    return !!m && !m.is_user && !isRealSystem(m) && m.name !== 'System';
}

// Bot replies among the first `n` non-system messages (converts counts saved by older versions).
function botsWithin(n) {
    let seen = 0, bots = 0;
    for (const m of ctx().chat) {
        if (m.is_system) continue;
        if (seen >= n) break;
        seen++;
        if (!m.is_user) bots++;
    }
    return bots;
}

// Bot replies from chat index `from` to the end (hidden replies included).
function botsSince(from) {
    const chat = ctx().chat;
    let n = 0;
    for (let i = Math.max(0, from); i < chat.length; i++) if (isBotReply(chat[i])) n++;
    return n;
}

// Raw clock for an arc: replies since it started (index based, so hiding old turns cannot shrink it).
function absCount(arc) {
    return arc.baseIndex != null ? botsSince(arc.baseIndex) : messageCount();
}

// Index where the last `n` bot replies begin (used to anchor older arcs).
function indexBeforeLast(n) {
    const chat = ctx().chat;
    let count = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isBotReply(chat[i])) count++;
        if (count > n) return i + 1;
    }
    return 0;
}

function migrateCounting(arc) {
    if (arc.countMode === 'idx') return;
    const started = arc.status !== 'setup' && arc.status !== 'draft';
    if (started && arc.countMode !== 'bot') {
        // Oldest arcs counted user messages too: convert their stage marks to bot replies first.
        const oldBase = Number(arc.base) || 0;
        const toNew = p => Math.max(0, botsWithin(oldBase + p) - botsWithin(oldBase));
        arc.stageStarts = (arc.stageStarts || []).map(toNew);
        arc.lastJudge = toNew(Number(arc.lastJudge) || 0);
        arc.setup.length = Math.max(5, Math.round(Number(arc.setup.length) / 2));
    }
    if (started) {
        // Visible-only counting shrank when a summary extension hid old turns.
        // Anchor to the chat so progress resumes from the current stage's start.
        const target = Math.max(0, Number(arc.stageStarts?.[arc.current]) || 0, Number(arc.lastJudge) || 0);
        arc.baseIndex = indexBeforeLast(target);
        arc.base = 0;
        if (arc.frozenAt != null) arc.frozenAt = target;
    }
    arc.countMode = 'idx';
}

function isFrozen(arc) {
    return arc.status === 'paused' || (arc.hold && arc.status === 'running');
}

function progress(arc) {
    const now = arc.frozenAt != null ? arc.frozenAt : absCount(arc);
    return Math.max(0, now - arc.base);
}

// Pause and hold both freeze the pacing clock; chats written meanwhile are not counted.
function syncFreeze(arc) {
    if (isFrozen(arc) && arc.frozenAt == null) {
        arc.frozenAt = absCount(arc);
    } else if (!isFrozen(arc) && arc.frozenAt != null) {
        arc.base += Math.max(0, absCount(arc) - arc.frozenAt);
        arc.frozenAt = null;
    }
}

function pauseArc(arc) {
    syncFreeze(arc);
    arc.status = 'paused';
    syncFreeze(arc);
    pushLog(arc, true, `${arc.current + 1}단계에서 일시정지`);
}

function resumeArc(arc) {
    arc.status = 'running';
    syncFreeze(arc);
    pushLog(arc, true, `${arc.current + 1}단계 다시 시작`);
}

function toggleHold(arc) {
    syncFreeze(arc);
    arc.hold = !arc.hold;
    syncFreeze(arc);
    pushLog(arc, true, arc.hold ? `${arc.current + 1}단계에 머물기 시작` : `${arc.current + 1}단계 머물기 끝`);
}

function stageStart(arc) {
    return arc.stageStarts[arc.current] ?? 0;
}

// A stage's share: a number the user fixed, else the AI's suggested weight, else an even share.
function stageWeight(st, fallback) {
    const w = Number(st.suggested);
    return Number.isFinite(w) && w > 0 ? w : fallback;
}

function isFixed(st) {
    return Number.isFinite(Number(st.chats)) && Number(st.chats) > 0;
}

// Planned chats for stages[from..]: fixed ones keep their number, the rest share what is left by weight.
function planBudgets(arc, from, chatsLeft) {
    const rest = arc.stages.slice(from);
    const fixedSum = rest.filter(isFixed).reduce((n, st) => n + Number(st.chats), 0);
    const auto = rest.filter(st => !isFixed(st));
    const known = auto.map(st => Number(st.suggested)).filter(w => Number.isFinite(w) && w > 0);
    const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    const weightSum = auto.reduce((n, st) => n + stageWeight(st, avg), 0) || 1;
    const pool = Math.max(0, chatsLeft - fixedSum);
    return rest.map(st => isFixed(st)
        ? Number(st.chats)
        : Math.max(2, Math.round(pool * stageWeight(st, avg) / weightSum)));
}

// What each stage got when the whole length was split up front. A long earlier
// stage never squeezes the ones after it below this; spare chats still flow forward.
function baseBudgets(arc) {
    return planBudgets(arc, 0, Number(arc.setup.length));
}

function stageBudget(arc) {
    const chatsLeft = Math.max(0, Number(arc.setup.length) - stageStart(arc));
    const now = planBudgets(arc, arc.current, chatsLeft)[0] || 2;
    return Math.max(2, now, baseBudgets(arc)[arc.current] || 0);
}

// Budget shown on each stage row: done stages show what they took, the rest the current plan.
function displayBudgets(arc) {
    const started = arc.status !== 'draft' && arc.status !== 'setup';
    if (!started) return planBudgets(arc, 0, Number(arc.setup.length));
    const out = arc.stages.map(() => null);
    const nextFrom = arc.status === 'done' ? arc.stages.length : arc.current;
    if (nextFrom < arc.stages.length) {
        const plan = planBudgets(arc, nextFrom, Math.max(0, Number(arc.setup.length) - stageStart(arc)));
        const base = baseBudgets(arc);
        plan.forEach((b, k) => { out[nextFrom + k] = Math.max(b, base[nextFrom + k] || 0); });
    }
    return out;
}

function ripeness(arc) {
    return (progress(arc) - stageStart(arc)) / stageBudget(arc);
}

// Harder characters ripen slower and are judged later.
const DIFFICULTY = {
    easy: { label: '순한맛', pace: 1.15, min: -0.1, hint: '흐름에 잘 맞춰줘요' },
    normal: { label: '기본', pace: 1, min: 0, hint: '지금 그대로예요' },
    hard: { label: '매운맛', pace: 0.8, min: 0.1, hint: '쉽게 안 넘어와요. 깡캐가 움직여야 조금씩 풀리고, 판정도 늦게 시작해요' },
    hell: { label: '지옥맛', pace: 0.65, min: 0.2, hint: '먼저 다가오는 일은 거의 없어요. 깡캐가 실수하면 단계가 뒤로 밀릴 수도 있어요' },
};

function diff(arc) {
    return DIFFICULTY[arc.setup.difficulty] || DIFFICULTY.normal;
}

function effRipeness(arc) {
    return ripeness(arc) * diff(arc).pace;
}

// Short stages get checked more often: never wait longer than about a quarter of the stage.
function judgeInterval(arc) {
    const setting = Math.max(1, Number(getSettings().judgeInterval) || 5);
    return Math.max(1, Math.min(setting, Math.round(stageBudget(arc) / 4) || 1));
}

// Share of the stage budget that must pass before judging starts.
function judgeGate(arc) {
    const d = diff(arc);
    const min = Math.min(0.95, Math.max(0, Number(getSettings().minRatio) + d.min));
    return Math.min(1.5, min / d.pace);
}

function phaseLabel(r) {
    if (r < 0.3) return '막 시작됐어요';
    if (r < 0.7) return '스며드는 중';
    if (r < 1.0) return '무르익는 중';
    return '충분히 익었어요';
}

// ---------- editable prompts ----------
// Every prompt the model reads lives here so users can edit and share them.
// {{name}} placeholders are filled in code; a line whose placeholder is empty is dropped.

const DEFAULT_PROMPTS = Object.freeze({
    inject: [
        '[Background story direction — for the narrator only]',
        'Long-term story for {{char}} and {{user}}: {{story}}',
        'Where it is heading (do not rush there): {{ending}}',
        'Overall tone: {{tone}}',
        'Notes: {{notes}}',
        'Obstacles in play: {{obstacles}}',
        'How {{char}} behaves: {{difficulty}}',
        'Current chapter ({{chapter_num}}/{{chapter_total}}): {{chapter}}',
        'Mood of this chapter: {{chapter_mood}}',
        'Who drives this chapter: {{lead}}',
        'Pacing: {{pacing}}',
        '{{foreshadow}}',
        '{{event}}',
        '{{nudge}}',
        'Rules:',
        '- The scene in progress and {{user}}\'s actions always come first. Follow them fully; never steer away from what {{user}} is doing.',
        '- Use this direction only where it fits naturally. It is completely fine for a reply not to touch it at all.',
        '- Change happens gradually, through small believable moments. Never resolve the chapter in a single reply, and never jump ahead to later developments.',
        '- Keep every character consistent with their established personality.',
        '- Never mention chapters, arcs, goals, or this note. Keep writing in the roleplay\'s current language.',
    ].join('\n'),
    paceEarly: 'This chapter has only just begun. At most, let it surface as a faint undercurrent: a passing thought, a small gesture, a detail in the surroundings. Do not start the chapter\'s main development yet.',
    paceMid: 'This chapter is underway. When the scene naturally allows it, let things move a small, believable step in this direction.',
    paceLate: 'This chapter is maturing. If the flow of the scene supports it, its key development may begin to happen, arising from the characters\' own motives rather than being forced.',
    paceOver: 'This chapter has been building for a while. Look for natural openings to bring it to fruition, but still never cut off what {{user}} is doing or force a sudden turn.',
    paceHold: 'Stay within this chapter. Keep its mood and dynamic alive and explore it in depth, but do not move the story beyond it or hint at later developments.',
    plan: [
        'Turn the story outline below into a slow, natural long-term plot arc for an ongoing roleplay.',
        '',
        'Characters:',
        '- {{char}}: {{char_description}}',
        '- {{user}}: {{persona}}',
        '',
        'Cast in this chat: {{cast}}',
        '',
        'Story outline from the user:',
        '{{story}}',
        '',
        'Desired ending or destination: {{ending}}',
        'Desired tone: {{tone}}',
        'Things the user wants kept: {{keep}}',
        'How {{char}} should behave: {{difficulty}}',
        '{{obstacles}}',
        '{{world_info}}',
        '',
        '{{summary}}',
        '',
        '{{recent_chat}}',
        '',
        'Total length: about {{length}} replies from {{char}} (each usually answering one message from {{user}}).',
        'Number of chapters: {{chapter_count}}',
        '',
        'Guidelines:',
        '- Follow the user\'s outline faithfully, including dark or painful developments if that is what they asked for. This is fiction the user chose for their own story.',
        '- Each chapter is a phase of the story (situation, turning point, and its emotional aftermath), not a single scripted scene. It must be able to unfold gradually over many messages while leaving room for unrelated scenes and the user\'s own choices.',
        '- Build up to major events: show foreshadowing and setup before a turning point, and give its aftermath room to breathe. No abrupt jumps.',
        '- Respect the characters\' established personalities and the current situation of the roleplay. If recent conversation is given, start chapter 1 from exactly where the story is now and build on the people, events and unresolved threads already in it.',
        '- The user\'s inputs above may be written in Korean; understand them as given.',
    ].join('\n'),
    judge: [
        'You are checking the progress of a slowly developing story arc in a roleplay.',
        '',
        'Current chapter: {{chapter}}',
        'Next chapter (for reference only): {{next_chapter}}',
        '',
        'Recent messages:',
        '{{recent_messages}}',
        '',
        '{{difficulty_judge}}',
        'Question: has the development described in the current chapter substantially taken place, so the story is ready to move on? Be conservative: a single hint or a partial step does not count.',
    ].join('\n'),
    ideas: [
        'Suggest {{count}} different long-term story ideas for an ongoing roleplay. Each idea is a storyline that can slowly unfold over a few hundred messages.',
        '',
        'Cast in this chat: {{cast}}',
        'Characters:',
        '- {{char}}: {{char_description}}',
        '- {{user}}: {{persona}}',
        '{{world_info}}',
        '',
        '{{summary}}',
        '',
        '{{recent_chat}}',
        '',
        'Tone the user wants: {{tone}}',
        'Keywords to weave in: {{keywords}}',
        'Boldness: {{spice}}',
        'Tropes the user wants woven in (they may be in Korean): {{tropes}}',
        'Ending direction: {{ending_dir}}',
        'Whose story it centers on: {{focus}}',
        'Must avoid (the user\'s words, possibly in Korean): {{exclude}}',
        '{{variation_of}}',
        '{{obstacles}}',
        'Already suggested (do not repeat or closely resemble these): {{avoid}}',
        '',
        'Guidelines:',
        '- Each idea must fit these specific characters, their situation and their world. Avoid generic plots that could apply to anyone. With several characters in the cast, give the ideas different focal characters and let side members matter.',
        '- Make the ideas clearly different from each other in premise and direction.',
        '- Give each idea a clear direction and an ending to head toward, while leaving room for the user\'s own choices along the way.',
    ].join('\n'),
    diffEasy: '{{char}} is fairly open to where the story is heading and meets {{user}} halfway.',
    diffHard: '{{char}} does not make this easy. {{char}} resists, deflects or pushes back, never moves toward the story\'s direction on their own, and only shifts, reluctantly and a little at a time, in response to what {{user}} actually does.',
    diffHell: '{{char}} is deeply resistant. {{char}} actively pushes {{user}} away, almost never takes a step forward on their own, and any softening is small, hard-won and easily lost again if {{user}} misjudges the moment.',
    judgeHard: '{{char}} is meant to be hard to win over. Only count the chapter as done if {{user}}\'s own actions have clearly worn down {{char}}\'s resistance.',
    judgeHell: '{{char}} is meant to be extremely hard to win over. Only count the chapter as done if {{user}} has clearly earned it through their own actions, and notice if things have slipped backwards.',
    obstacles: 'Include obstacles: bring in {{obstacle_detail}} and weave them into the chapters so they get in the way of the story\'s direction and raise the stakes.',
    foreshadow: 'Foreshadowing: if it fits naturally, let this small detail surface in passing, without explaining it or drawing attention to it: {{seed}}',
    breather: 'This reply is a breather. Do not push the story\'s direction at all; let the moment be ordinary and unhurried, following whatever {{user}} is doing.',
    nudge: 'For this reply only: if the scene allows it at all, move this chapter forward by one clear, believable step. Still follow {{user}}\'s lead and do not jump ahead to later developments.',
    prefExpand: [
        'A user of a long-form roleplay wrote down something they personally enjoy in this story (a "taste point"). Turn it into short guidance for the narrator.',
        '',
        'Characters: {{char}} (the AI\'s character) and {{user}} (the user\'s character). Cast: {{cast}}',
        'The user\'s note (any language, may be casual or explicit; this is adult fiction the user chose for themselves):',
        '{{note}}',
        '',
        'Write:',
        '- label_ko: a very short Korean label (2-8 words) for this point.',
        '- aware_en: one English sentence the narrator keeps in mind at all times: the fact itself and what makes it appealing to the user. The appeal often lies in a contrast, a tension or a specific detail; name it plainly instead of softening or erasing it.',
        '- surface_en: two or three English sentences on natural, varied ways it can show when a scene invites it (a line of dialogue, a glance, a passing thought, a small detail of behavior, a choice made in the moment), fitting these characters.',
        '- avoid_en: one English sentence on what would ruin it, such as repeating the same phrase, exaggeration or caricature, bringing it up every reply, ignoring it where it obviously matters, or forcing it into scenes where it does not belong.',
        'Keep the user\'s intent exactly. Do not moralize, censor or water it down.',
    ].join('\n'),
    prefInject: [
        '[What the player behind {{user}} enjoys in this story — for the narrator only]',
        'Keep these in mind at all times. They are seasoning, not the plot:',
        '{{points}}',
        '- Never quote or paraphrase these notes, and do not bring them up in every reply; most replies should not touch them at all.',
        '- When one does come up, keep it brief and natural, worded differently each time, arising from the scene itself, never exaggerated.',
        '- The same goes for intimate or explicit scenes: let a relevant preference shape them naturally and vary it over time instead of forcing it.',
        '{{cue}}',
    ].join('\n'),
    prefCue: 'For this reply: if the moment genuinely invites it, let this one surface briefly (a line or a detail at most): {{surface}} Avoid: {{avoid}} If it does not fit the scene, skip it.',
    event: 'For this reply only: let one small unexpected event happen that fits the current scene and chapter (an interruption, a discovery, a visitor, a mishap, a sudden change of plans or weather). Keep it proportionate, do not resolve it, and leave room for {{user}} to react.',
    inner: [
        'Read the recent roleplay and describe what {{char}} is privately feeling right now about {{user}} and the situation: the thoughts {{char}} would never say out loud.',
        '',
        'Current chapter of the story: {{chapter}}',
        '',
        'Recent messages:',
        '{{recent_messages}}',
    ].join('\n'),
});

const SPICE_TEXT = {
    calm: 'Keep it grounded. Gentle developments that grow naturally out of where the story is right now.',
    mid: 'Balanced. A clear hook and a few turning points, still believable for these characters.',
    wild: 'Be bold. Surprising twists, big events or reveals, while staying true to the characters.',
};

// Output formats stay fixed so edited prompts can never break parsing.
const PLAN_FORMAT = [
    '',
    'Also give each chapter "chats": how many of the roughly {{length}} replies it should take. Brief interludes (a short visit, a single incident) get few; major turns and their aftermath get more. All chapters together should add up to about {{length}}.',
    'Work in English: design every chapter fully in the English fields first. The Korean fields come last and are natural Korean renderings of what you already wrote in English, not new ideas.',
    'Return JSON only, in exactly this shape and field order:',
    '{"arc":{"premise":"<the overall story in 1-2 English sentences>","ending":"<the destination in English, or empty>","tone":"<tone in English, one short phrase>","notes":"<things to keep, in English, or empty>","obstacles":"<the obstacle characters or situations in one English sentence, or empty>"},',
    ' "chapters":[{"title_en":"<short English title>","guide_en":"<2-3 English sentences on what unfolds in this chapter and how it feels>","chats":<integer>,"lead":"<who mainly drives this chapter: one name from the cast, or a side character; in a group chat, spread the spotlight across members>","mood_en":"<the emotional mood of this chapter in 1-3 English words; let it shift across chapters to form an arc>","seed_en":"<one small, concrete English detail to plant during this chapter that quietly foreshadows the next chapter without revealing it (an object, a habit, a passing remark); empty for the last chapter>","title_ko":"<the title in natural Korean>","summary_ko":"<the guide condensed into one or two natural Korean sentences>","mood_ko":"<the chapter mood in 1-3 Korean words>"}]}',
].join('\n');
const IDEAS_FORMAT = [
    '',
    'Work in English first: draft each idea in the English fields, then render it in natural Korean in the Korean fields.',
    `Return JSON only, in this field order: {"ideas":[{"title_en":"<short English title>","story_en":"<2-3 English sentences describing the storyline>","ending_en":"<one short English sentence: where it ends up>","title":"<the title in natural Korean>","story":"<the storyline in natural Korean>","ending":"<the ending in natural Korean>","moods":["<1-3 short Korean mood tags, preferably from: ${PRESETS.mood.join(', ')}>"]}]}`,
].join('\n');
const INNER_FIELDS = '"inner_ko": "<one short Korean line: {{char}}\'s private, unspoken feeling right now, in {{char}}\'s own inner voice>", "warmth": <integer 0-100: how open {{char}} currently is toward {{user}}>';

function judgeFormat(regress, inner) {
    const fields = ['"done": true or false', '"reason_ko": "<one short Korean sentence explaining why>"', '"detail_ko": "<2-4 Korean sentences: what has already happened toward this chapter, and what is still missing before it can be called done>"'];
    if (regress) fields.push('"regress": <true only if {{user}}\'s recent actions clearly pushed things back to before this chapter began, otherwise false>');
    if (inner) fields.push(INNER_FIELDS);
    return `\n\nAnswer with JSON only: {${fields.join(', ')}}`;
}

const PROMPT_INFO = {
    inject: { label: '매 턴 들어가는 방향 문장', vars: 'char, user, story, ending, tone, notes, obstacles, difficulty, chapter, chapter_num, chapter_total, chapter_mood, lead, pacing, foreshadow, event, nudge' },
    paceEarly: { label: '페이스: 막 시작됐을 때', vars: 'char, user' },
    paceMid: { label: '페이스: 스며드는 중', vars: 'char, user' },
    paceLate: { label: '페이스: 무르익는 중', vars: 'char, user' },
    paceOver: { label: '페이스: 충분히 익었을 때', vars: 'char, user' },
    paceHold: { label: '페이스: 머물기 중', vars: 'char, user' },
    plan: { label: '과정 만들기', vars: 'char, user, cast, char_description, persona, story, ending, tone, keep, difficulty, obstacles, world_info, summary, recent_chat, length, chapter_count', fixed: true },
    judge: { label: '단계 판정', vars: 'char, user, chapter, next_chapter, recent_messages, difficulty_judge', fixed: true },
    ideas: { label: '아이디어 추천', vars: 'char, user, cast, char_description, persona, world_info, summary, recent_chat, tone, keywords, spice, tropes, ending_dir, focus, exclude, variation_of, obstacles, avoid, count', fixed: true },
    diffEasy: { label: '난이도: 순한맛 태도', vars: 'char, user' },
    diffHard: { label: '난이도: 매운맛 태도', vars: 'char, user' },
    diffHell: { label: '난이도: 지옥맛 태도', vars: 'char, user' },
    judgeHard: { label: '난이도: 매운맛 판정 기준', vars: 'char, user' },
    judgeHell: { label: '난이도: 지옥맛 판정 기준', vars: 'char, user' },
    obstacles: { label: '방해꾼 등장', vars: 'char, user, obstacle_detail' },
    inner: { label: '속마음 엿보기', vars: 'char, user, chapter, recent_messages', fixed: true },
    foreshadow: { label: '복선 심기', vars: 'char, user, seed' },
    breather: { label: '숨 고르기 턴', vars: 'char, user' },
    event: { label: '돌발 사건', vars: 'char, user' },
    nudge: { label: '한 번만 살짝 밀기', vars: 'char, user' },
    prefInject: { label: '취향: 매 턴 들어가는 문장', vars: 'char, user, points, cue' },
    prefCue: { label: '취향: 가끔 한 번 묻어나게', vars: 'char, user, surface, avoid' },
    prefExpand: { label: '취향: 풀어 쓰기', vars: 'char, user, cast, note', fixed: true },
};

function getPrompt(key) {
    const custom = getSettings().prompts?.[key];
    return typeof custom === 'string' && custom.trim() ? custom : DEFAULT_PROMPTS[key];
}

function fillTemplate(tpl, vars) {
    const out = [];
    for (const line of tpl.split('\n')) {
        let empty = false;
        const filled = line.replace(/\{\{(\w+)\}\}/g, (m, k) => {
            if (!Object.hasOwn(vars, k)) return m;
            const v = String(vars[k] ?? '').trim();
            if (!v) empty = true;
            return v;
        });
        if (!empty) out.push(filled);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function difficultyText(arc, base) {
    const key = { easy: 'diffEasy', hard: 'diffHard', hell: 'diffHell' }[arc.setup.difficulty];
    return key ? fillTemplate(getPrompt(key), base) : '';
}

function difficultyJudgeText(arc, base) {
    const key = { hard: 'judgeHard', hell: 'judgeHell' }[arc.setup.difficulty];
    return key ? fillTemplate(getPrompt(key), base) : '';
}

function obstacleText(arc, base) {
    const su = arc.setup;
    if (!su.obstacles) return '';
    const detail = su.obstacleText.trim()
        ? `this (the user's idea, possibly in Korean): ${su.obstacleText.trim()}`
        : 'one or more fitting characters or situations (for example a rival, a meddler, or outside trouble) that suit the world';
    return fillTemplate(getPrompt('obstacles'), { ...base, obstacle_detail: detail });
}

function phaseInstruction(r, vars) {
    const key = r < 0.3 ? 'paceEarly' : r < 0.7 ? 'paceMid' : r < 1.0 ? 'paceLate' : 'paceOver';
    return fillTemplate(getPrompt(key), vars);
}

// ---------- prompt injection ----------

function buildInjection(arc) {
    const { name1, name2 } = ctx();
    const st = arc.stages[arc.current];
    if (!st) return '';
    const en = arc.arcEn ?? {};
    const base = { char: name2, user: name1 };
    const su = arc.setup;
    const nextReply = progress(arc) + 1;
    const breather = !arc.hold && isBreather(arc, nextReply);
    const pacing = breather
        ? fillTemplate(getPrompt('breather'), base)
        : arc.hold ? fillTemplate(getPrompt('paceHold'), base) : phaseInstruction(effRipeness(arc), base);
    // Seeds surface every third reply so they stay occasional.
    const seed = su.foreshadow && !breather && st.seed_en && nextReply % 3 === 0
        ? fillTemplate(getPrompt('foreshadow'), { ...base, seed: st.seed_en }) : '';
    const event = arc.eventPending && !breather ? fillTemplate(getPrompt('event'), base) : '';
    const nudge = arc.nudgePending && !breather && !arc.hold ? fillTemplate(getPrompt('nudge'), base) : '';
    return fillTemplate(getPrompt('inject'), {
        ...base,
        story: en.premise || arc.setup.plot,
        ending: en.ending,
        tone: en.tone,
        notes: en.notes,
        obstacles: en.obstacles,
        difficulty: difficultyText(arc, base),
        chapter: `${st.title_en || st.title_ko}. ${st.guide_en || st.summary_ko}`,
        chapter_num: arc.current + 1,
        chapter_total: arc.stages.length,
        pacing,
        foreshadow: seed,
        event,
        nudge,
        chapter_mood: st.mood_en || st.mood_ko || '',
        lead: st.lead || '',
    });
}

function isBreather(arc, replyNo) {
    const every = Math.max(2, Number(arc.setup.breatherEvery) || 5);
    return !!arc.setup.breather && replyNo % every === 0;
}

const AUTO_EVENT_CHANCE = 0.12;

// ---------- taste points ----------

const PREF_KEY = MODULE + '_prefs';
const PREF_FREQ = {
    low: { label: '은은하게', every: 8 },
    mid: { label: '가끔', every: 5 },
    high: { label: '자주', every: 3 },
};
const PREF_FORMAT = 'Answer with JSON only: {"label_ko":"<short Korean label>","aware_en":"<one English sentence>","surface_en":"<two or three English sentences>","avoid_en":"<one English sentence>"}';

function activePrefs(arc) {
    return (arc?.prefs || []).filter(p => p.on !== false && (p.aware || p.text));
}

function prefOffset(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 997;
    return h;
}

// Which point (if any) gets a gentle cue for reply number `turn`. Pure function of the turn,
// so regenerating the same reply gets the same cue. Cues only land on every other reply,
// so several points never pile up into a cue on every turn.
function prefCueFor(arc, turn) {
    if (turn % 2) return null;
    const due = activePrefs(arc).filter(p => {
        const every = (PREF_FREQ[p.freq] || PREF_FREQ.mid).every;
        const off = prefOffset(p.id);
        return (turn + off) % every === 0 || (turn - 1 + off) % every === 0;
    });
    return due.length ? due[(turn / 2) % due.length] : null;
}

// AI-written guidance may use {{user}} / {{char}}; fill them in ourselves.
function withNames(text) {
    const c = ctx();
    return String(text || '').replace(/\{\{user\}\}/gi, c.name1).replace(/\{\{char\}\}/gi, c.name2);
}

function buildPrefInjection(arc) {
    const c = ctx();
    const prefs = activePrefs(arc);
    if (!prefs.length) return '';
    const base = { char: c.name2, user: c.name1 };
    const cue = prefCueFor(arc, messageCount() + 1);
    return fillTemplate(getPrompt('prefInject'), {
        ...base,
        points: prefs.map(p => `- ${withNames(p.aware || p.text)}`).join('\n'),
        cue: cue ? fillTemplate(getPrompt('prefCue'), {
            ...base,
            surface: withNames(cue.surface || cue.aware || cue.text),
            avoid: withNames(cue.avoid || 'repeating the same phrase, exaggerating it, or forcing it.'),
        }) : '',
    });
}

function updatePrefInjection() {
    const { setExtensionPrompt } = ctx();
    const s = getSettings();
    const arc = hasChat() ? getArc() : null;
    const text = s.enabled && arc && arc.prefsOn !== false ? buildPrefInjection(arc) : '';
    if (!text) { setExtensionPrompt(PREF_KEY, '', PROMPT_NONE, 0); return; }
    setExtensionPrompt(PREF_KEY, text, PROMPT_IN_CHAT, Number(s.depth), false, ROLES[s.role] ?? 0);
}

async function expandPref(arc, text) {
    const c = ctx();
    const prompt = fillTemplate(getPrompt('prefExpand'), {
        char: c.name2,
        user: c.name1,
        cast: castNames().join(', '),
        note: text,
    }) + '\n\n' + PREF_FORMAT;
    const data = parseJson(await askLLM('You turn a roleplay user\'s personal preferences into concise narrator guidance. Output only valid JSON.', prompt, 900));
    const aware = String(data.aware_en ?? '').trim();
    if (!aware) throw replyError('AI가 내용을 비워서 보냈어요');
    return {
        label: String(data.label_ko ?? '').trim(),
        aware,
        surface: String(data.surface_en ?? '').trim(),
        avoid: String(data.avoid_en ?? '').trim(),
        failed: false,
    };
}

function updateInjection() {
    updatePrefInjection();
    const { setExtensionPrompt } = ctx();
    const s = getSettings();
    const arc = hasChat() ? getArc() : null;
    if (!s.enabled || !arc || arc.status !== 'running' || !arc.stages.length) {
        setExtensionPrompt(MODULE, '', PROMPT_NONE, 0);
        return;
    }
    setExtensionPrompt(MODULE, buildInjection(arc), PROMPT_IN_CHAT, Number(s.depth), false, ROLES[s.role] ?? 0);
}

// ---------- LLM helpers ----------

// Sends a planning/judging request through the chosen connection profile,
// or through the current connection when none is chosen.
const LLM_TIMEOUT_MS = 150000;

// Never let a stuck request freeze the panel: give up after a while.
function withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('응답이 너무 오래 걸려서 멈췄어요 (API 상태를 확인해 주세요)')), LLM_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function askLLM(systemPrompt, prompt, maxTokens = 1500) {
    return withTimeout(askLLMRaw(systemPrompt, prompt, maxTokens));
}

async function askLLMRaw(systemPrompt, prompt, maxTokens) {
    const c = ctx();
    const { profileId } = getSettings();
    if (profileId) {
        const svc = c.ConnectionManagerRequestService;
        if (!svc) throw new Error('연결 프로필 기능을 쓸 수 없어요');
        if (!svc.getSupportedProfiles().some(p => p.id === profileId)) throw new Error('고른 연결 프로필을 찾을 수 없어요');
        const res = await svc.sendRequest(profileId, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
        ], maxTokens);
        return typeof res === 'string' ? res : (res?.content ?? '');
    }
    return c.generateRaw({ systemPrompt, prompt, responseLength: maxTokens });
}

function listProfiles() {
    try {
        return ctx().ConnectionManagerRequestService?.getSupportedProfiles() ?? [];
    } catch {
        return [];
    }
}

// ---------- world info picker ----------

const wiCache = new Map();   // bookName -> entries[] (null while loading)

function linkedBooks() {
    const c = ctx();
    const books = new Set();
    const ch = c.characters?.[c.characterId];
    if (ch?.data?.extensions?.world) books.add(ch.data.extensions.world);
    if (c.chatMetadata?.world_info) books.add(c.chatMetadata.world_info);
    return [...books];
}

function allBooks() {
    try { return ctx().getWorldInfoNames(); } catch { return []; }
}

const wiLoading = new Map();   // bookName -> pending load

function ensureBook(name) {
    if (!name) return Promise.resolve();
    if (wiLoading.has(name)) return wiLoading.get(name);
    if (wiCache.has(name) && wiCache.get(name) !== null) return Promise.resolve();
    const job = loadBook(name).finally(() => wiLoading.delete(name));
    wiLoading.set(name, job);
    return job;
}

// Every book with picked entries must be loaded before its text is used
// (after a page reload only the book on screen is in the cache).
async function loadPickedBooks(arc) {
    await Promise.all(Object.keys(arc.setup.wi).map(b => ensureBook(b)));
}

async function loadBook(name) {
    wiCache.set(name, null);
    try {
        const data = await ctx().loadWorldInfo(name);
        const entries = Object.values(data?.entries ?? {})
            .filter(e => e && !e.disable)
            .sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid))
            .map(e => ({
                uid: e.uid,
                label: e.comment || (Array.isArray(e.key) ? e.key.join(', ') : '') || `#${e.uid}`,
                content: String(e.content ?? ''),
            }));
        wiCache.set(name, entries);
    } catch (err) {
        console.error(LOG, 'loadWorldInfo failed', err);
        wiCache.set(name, []);
    }
    softRender();
}

function selectedWiText(arc) {
    const parts = [];
    let total = 0;
    for (const [book, uids] of Object.entries(arc.setup.wi)) {
        const entries = wiCache.get(book) || [];
        for (const e of entries) {
            if (!uids.includes(e.uid) || total > 6000) continue;
            const t = clip(e.content, 1200);
            total += t.length;
            parts.push(`- ${e.label}: ${t}`);
        }
    }
    return parts.join('\n');
}

// Names of the picked entries, book by book (books still loading are fetched in the background).
function pickedWiLabels(arc) {
    const out = [];
    for (const [book, uids] of Object.entries(arc.setup.wi)) {
        const entries = wiCache.get(book);
        if (!entries) { ensureBook(book); continue; }
        for (const e of entries) if (uids.includes(e.uid)) out.push(e.label);
    }
    return out;
}

function wiPickedHtml(arc) {
    const n = wiCount(arc);
    if (!n) return '';
    const labels = pickedWiLabels(arc);
    const shown = labels.slice(0, 8).join(', ');
    const rest = n - Math.min(labels.length, 8);
    return `고른 항목: ${esc(shown || '불러오는 중…')}${rest > 0 ? ` 외 ${rest}개` : ''}`;
}

function wiBookChipsHtml(arc) {
    const s = arc.setup;
    const books = Object.keys(s.wi);
    if (!books.length) return '';
    return books.map(b => `<button type="button" class="sb-chip sb-wi-book ${b === s.wiBook ? 'on' : ''}" data-act="wiBookOpen" data-value="${esc(b)}"><i class="fa-solid fa-book"></i> ${esc(b)} <b>${s.wi[b].length}</b></button>`).join('');
}

function wiCount(arc) {
    return Object.values(arc.setup.wi).reduce((n, u) => n + u.length, 0);
}

function replyError(msg) {
    const e = new Error(msg);
    e.spReply = true;   // the API answered; the problem is the answer itself
    return e;
}

function snippet(text, n = 60) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
}

function parseJson(text) {
    if (!text || !String(text).trim()) {
        throw replyError('AI가 빈 답을 보냈어요. 모델 필터(검열)에 막혔을 가능성이 커요. 다른 모델로 해보거나 내용을 조금 순하게 써 보세요');
    }
    let t = String(text).replace(/```(?:json)?/gi, '').trim();
    const first = t.search(/[[{]/);
    const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    const cut = 'AI 답이 중간에 끊겼거나 형식이 깨졌어요. 다시 눌러 보거나, 너무 길면 단계 수를 줄여 보세요';
    if (first >= 0 && last < first) {
        console.warn('[Slow Plot] cut-off reply:', text);
        throw replyError(cut);
    }
    if (first < 0) {
        console.warn('[Slow Plot] non-JSON reply:', text);
        throw replyError(`AI가 형식 대신 일반 문장으로 답했어요. 보통 모델이 내용을 거절(검열)한 경우예요. 답 앞부분: "${snippet(text)}"`);
    }
    try {
        return JSON.parse(t.slice(first, last + 1));
    } catch {
        console.warn('[Slow Plot] broken JSON reply:', text);
        throw replyError(cut);
    }
}

function clip(text, max) {
    const s = String(text ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function moodList(arc) {
    const s = arc.setup;
    const moods = [...s.moods];
    if (s.moodCustomOn && s.moodCustom.trim()) moods.push(s.moodCustom.trim());
    return moods;
}

// Names in this chat: group members in a group chat, otherwise the bot; plus the user.
function castNames() {
    const c = ctx();
    const names = [];
    const arc = hasChat() ? getArc() : null;
    const extra = String(arc?.setup?.castExtra || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
    if (c.groupId) {
        const g = (c.groups || []).find(x => x.id === c.groupId);
        for (const av of g?.members || []) {
            const ch = (c.characters || []).find(x => x.avatar === av);
            if (ch?.name) names.push(ch.name);
        }
    }
    if (!names.length && !extra.length && c.name2) names.push(c.name2);
    names.push(...extra);
    if (c.name1) names.push(c.name1);
    return [...new Set(names)];
}

// Summaries other extensions keep injected into the prompt (read-only).
const SUMMARY_SOURCES = {
    'scenario-summarizer': '시나리오 자동요약',
    '1_memory': '실리 기본 요약',
    'memoria_ledger': 'Memoria',
    'long_memory_main': '코끼리를 생각하지마',
    'long_memory_anchor': '코끼리 (현재 상태)',
};
// Per-turn recall snippets: about the last reply only, not the story so far.
const SUMMARY_SKIP = new Set(['long_memory_recall']);

function findSummaries() {
    const prompts = ctx().extensionPrompts || {};
    const out = [];
    for (const [key, p] of Object.entries(prompts)) {
        if (key === MODULE || SUMMARY_SKIP.has(key)) continue;
        const known = SUMMARY_SOURCES[key];
        if (!known && !/summar|memor|요약/i.test(key)) continue;
        const text = String(p?.value ?? '').trim();
        if (text) out.push({ key, label: known || key, text });
    }
    return out;
}

function summaryNote() {
    const found = findSummaries();
    if (!found.length) return '지금 들어가 있는 요약이 없어요. 요약 확장(시나리오 자동요약, 코끼리를 생각하지마, Memoria, 실리 기본 요약 등)이 요약을 넣고 있으면 자동으로 찾아서 읽어요';
    return `찾은 요약: ${found.map(f => `${esc(f.label)} (${f.text.length.toLocaleString()}자)`).join(', ')} · 과정 만들기와 아이디어 추천에 같이 반영돼요`;
}

function summaryBlock(arc) {
    if (arc.setup.useSummary === false) return '';
    const found = findSummaries();
    if (!found.length) return '';
    const body = found.map(f => clip(f.text, Math.floor(6000 / found.length))).join('\n\n');
    return `Summary of the story so far (from the chat's long-term memory; treat it as what has already happened):\n${body}`;
}

// Edited prompts may not have {{summary}}; then it rides along with the recent chat slot.
function withSummary(template, vars, summary) {
    if (!summary || template.includes('{{summary}}')) return { ...vars, summary };
    return { ...vars, summary, recent_chat: [summary, vars.recent_chat].filter(Boolean).join('\n\n') };
}

function recentChatBlock(count, maxEach) {
    const recent = ctx().chat.filter(m => !m.is_system).slice(-count);
    if (!recent.length) return '';
    return 'Recent conversation (the story so far, most recent last):\n' + recent.map(m => `${m.name}: ${clip(m.mes, maxEach)}`).join('\n');
}

async function generateStages(arc) {
    const c = ctx();
    const moods = moodList(arc);
    const su = arc.setup;
    const charDesc = su.useChar ? clip(c.substituteParams('{{description}}\n{{personality}}'), 2000) : '';
    const persona = su.usePersona ? clip(c.substituteParams('{{persona}}'), 1000) : '';
    await loadPickedBooks(arc);
    const lore = selectedWiText(arc);
    const count = arc.setup.stageCount === 'auto'
        ? 'Choose between 3 and 8, based on the total length and how much story there is.'
        : `Exactly ${arc.setup.stageCount}.`;

    const planTpl = getPrompt('plan');
    const prompt = fillTemplate(planTpl, withSummary(planTpl, {
        char: c.name2,
        user: c.name1,
        char_description: charDesc,
        persona,
        story: su.plot.trim(),
        ending: su.ending.trim(),
        tone: moods.join(', '),
        keep: su.memo.trim(),
        difficulty: difficultyText(arc, { char: c.name2, user: c.name1 }),
        obstacles: obstacleText(arc, { char: c.name2, user: c.name1 }),
        world_info: lore ? `World info (background facts; do not contradict them):\n${lore}` : '',
        recent_chat: su.planUseChat ? recentChatBlock(su.chatCount, 500) : '',
        cast: castNames().join(', '),
        length: su.length,
        chapter_count: count,
    }, summaryBlock(arc))) + '\n' + fillTemplate(PLAN_FORMAT, { length: su.length });

    const raw = await askLLM('You are a story planner for long-form collaborative roleplay. Output only valid JSON.', prompt, 4000);
    const data = parseJson(raw);
    const chapters = Array.isArray(data.chapters) ? data.chapters : [];
    if (!chapters.length) throw new Error('단계가 비어 있음');
    arc.arcEn = {
        premise: String(data.arc?.premise ?? ''),
        ending: String(data.arc?.ending ?? ''),
        tone: String(data.arc?.tone ?? ''),
        notes: String(data.arc?.notes ?? ''),
        obstacles: String(data.arc?.obstacles ?? ''),
    };
    arc.stages = chapters.map(ch => ({
        title_ko: String(ch.title_ko ?? ''),
        summary_ko: String(ch.summary_ko ?? ''),
        title_en: String(ch.title_en ?? ''),
        guide_en: String(ch.guide_en ?? ''),
        suggested: Number.isFinite(Number(ch.chats)) && Number(ch.chats) > 0 ? Math.round(Number(ch.chats)) : null,
        chats: null,
        seed_en: String(ch.seed_en ?? ''),
        mood_en: String(ch.mood_en ?? ''),
        lead: String(ch.lead ?? ''),
        mood_ko: String(ch.mood_ko ?? ''),
    }));
}

async function translateStage(arc, st) {
    const c = ctx();
    const en = arc.arcEn ?? {};
    const prompt = [
        'Translate this chapter of a roleplay story arc into English.',
        `Story context: ${en.premise || arc.setup.plot}`,
        `Korean title: ${st.title_ko}`,
        `Korean summary: ${st.summary_ko}`,
        '',
        'Return JSON only: {"title_en":"<short English title>","guide_en":"<2-3 English sentences on what unfolds in this chapter and how it feels>"}',
    ].join('\n');
    const data = parseJson(await askLLM('You are a precise translator. Output only valid JSON.', prompt, 1000));
    st.title_en = String(data.title_en ?? st.title_ko);
    st.guide_en = String(data.guide_en ?? st.summary_ko);
}

const IDEA_ENDINGS = {
    any: ['상관없음', ''],
    happy: ['해피', 'a happy ending'],
    sad: ['새드', 'a sad or bittersweet ending'],
    open: ['열린 결말', 'an open ending that leaves room to continue'],
    twist: ['반전', 'an ending with a twist the reader will not see coming'],
};
const IDEA_FOCUS = {
    both: ['둘 다', ''],
    char: ['깡통 중심', 'mostly {{char}}: their inner life, past and choices drive it'],
    user: ['깡캐 중심', 'mostly {{user}}: their situation and choices drive it'],
    ensemble: ['주변 인물까지', 'an ensemble: side characters and their own stakes matter too'],
};

async function suggestIdeas(arc, count, avoid = [], variationOf = null) {
    const c = ctx();
    const su = arc.setup;
    const charDesc = su.useChar ? clip(c.substituteParams('{{description}}\n{{personality}}'), 2000) : '';
    const persona = su.usePersona ? clip(c.substituteParams('{{persona}}'), 1000) : '';
    await loadPickedBooks(arc);
    const lore = selectedWiText(arc);
    const recent = su.ideaUseChat
        ? c.chat.filter(m => !m.is_system).slice(-Number(su.chatCount || 30)).map(m => `${m.name}: ${clip(m.mes, 400)}`).join('\n')
        : '';
    const ideasTpl = getPrompt('ideas');
    const prompt = fillTemplate(ideasTpl, withSummary(ideasTpl, {
        char: c.name2,
        user: c.name1,
        char_description: charDesc,
        persona,
        world_info: lore ? `World info (background facts):\n${lore}` : '',
        recent_chat: recent ? `Recent conversation (start from the current situation):\n${recent}` : '',
        tone: moodList(arc).join(', '),
        keywords: su.ideaKeywords.trim(),
        spice: SPICE_TEXT[su.ideaSpice] || SPICE_TEXT.mid,
        obstacles: obstacleText(arc, { char: c.name2, user: c.name1 }),
        avoid: avoid.map(i => `${i.title}: ${i.story}`).join(' / '),
        tropes: su.ideaTropes.join(', '),
        cast: castNames().join(', '),
        ending_dir: (IDEA_ENDINGS[su.ideaEnding] || IDEA_ENDINGS.any)[1],
        focus: fillTemplate((IDEA_FOCUS[su.ideaFocus] || IDEA_FOCUS.both)[1], { char: c.name2, user: c.name1 }),
        exclude: su.ideaAvoid.trim(),
        variation_of: variationOf ? `Make every idea a variation on this one: keep its core premise and feel, but vary the turning points, stakes and ending so each is clearly its own take: ${variationOf.title}: ${variationOf.story} (ending: ${variationOf.ending})` : '',
        count,
    }, summaryBlock(arc))) + '\n' + IDEAS_FORMAT;
    const data = parseJson(await askLLM('You are a creative story consultant for long-form roleplay. Output only valid JSON.', prompt, 2400));
    const list = (Array.isArray(data.ideas) ? data.ideas : Array.isArray(data) ? data : [])
        .map(i => ({
            title: String(i.title ?? ''),
            story: String(i.story ?? ''),
            ending: String(i.ending ?? ''),
            moods: (Array.isArray(i.moods) ? i.moods : []).map(String).slice(0, 3),
        }))
        .filter(i => i.story);
    if (!list.length) throw new Error('추천이 비어 있음');
    return list.slice(0, count);
}

function applyIdea(arc, idea) {
    const su = arc.setup;
    su.plot = idea.story;
    su.ending = idea.ending;
    const known = idea.moods.filter(m => PRESETS.mood.includes(m));
    const other = idea.moods.filter(m => !PRESETS.mood.includes(m));
    su.moods = known;
    su.moodCustomOn = other.length > 0;
    su.moodCustom = other.join(', ');
}

async function judgeStage(arc) {
    const c = ctx();
    const s = getSettings();
    const st = arc.stages[arc.current];
    const next = arc.stages[arc.current + 1];
    const recent = c.chat.filter(m => !m.is_system).slice(-Number(s.judgeWindow));
    const transcript = recent.map(m => `${m.name}: ${clip(m.mes, 600)}`).join('\n');
    const base = { char: c.name2, user: c.name1 };
    const canRegress = arc.setup.difficulty === 'hell' && arc.current > 0;
    const prompt = fillTemplate(getPrompt('judge'), {
        ...base,
        chapter: `${st.title_en}. ${st.guide_en}`,
        next_chapter: next ? `${next.title_en}. ${next.guide_en}` : '',
        recent_messages: transcript,
        difficulty_judge: difficultyJudgeText(arc, base),
    }) + '\n\n' + fillTemplate(judgeFormat(canRegress, arc.setup.innerHint), base);
    const data = parseJson(await askLLM('You are a careful story analyst. Output only valid JSON.', prompt, 1500));
    return {
        done: data.done === true || data.done === 'true',
        regress: canRegress && (data.regress === true || data.regress === 'true'),
        reason: String(data.reason_ko ?? ''),
        detail: String(data.detail_ko ?? ''),
        inner: arc.setup.innerHint ? readInner(data) : null,
    };
}

function readInner(data) {
    const text = String(data.inner_ko ?? '').trim();
    if (!text) return null;
    const w = Math.round(Number(data.warmth));
    return { text, warmth: Number.isFinite(w) ? Math.min(100, Math.max(0, w)) : null };
}

async function peekInner(arc) {
    const c = ctx();
    const s = getSettings();
    const st = arc.stages[arc.current];
    const recent = c.chat.filter(m => !m.is_system).slice(-Number(s.judgeWindow));
    const base = { char: c.name2, user: c.name1 };
    const prompt = fillTemplate(getPrompt('inner'), {
        ...base,
        chapter: st ? `${st.title_en}. ${st.guide_en}` : '',
        recent_messages: recent.map(m => `${m.name}: ${clip(m.mes, 600)}`).join('\n'),
    }) + '\n\n' + fillTemplate(`Answer with JSON only: {${INNER_FIELDS}}`, base);
    const inner = readInner(parseJson(await askLLM('You are a perceptive reader of characters. Output only valid JSON.', prompt, 800)));
    if (!inner) throw new Error('속마음이 비어 있음');
    return inner;
}

// ---------- arc control ----------

function pushLog(arc, ok, text, detail = '') {
    arc.log.unshift({ at: progress(arc), ok, text, ...(detail ? { detail } : {}) });
    arc.log = arc.log.slice(0, 30);
}

function advance(arc, manual = false) {
    if (arc.current < arc.stages.length - 1) {
        arc.current++;
        arc.stageStarts[arc.current] = progress(arc);
        arc.stageStarts.length = arc.current + 1;
        arc.lastJudge = progress(arc);
        pushLog(arc, true, `${arc.current + 1}단계${stageTitle(arc, arc.current)} 시작${manual ? ' (직접 넘김)' : ''}`);
        if (manual || getSettings().stageToast !== false) toastr.success(`${arc.current + 1}단계로 넘어갔어요!`, 'Slow Plot');
    } else {
        arc.status = 'done';
        pushLog(arc, true, '모든 단계 완료! 🎉');
        if (manual || getSettings().stageToast !== false) toastr.success('모든 단계를 완료했어요!', 'Slow Plot');
    }
}

// Removes a stage and keeps the running position consistent.
function removeStage(arc, i) {
    const started = arc.status !== 'draft' && arc.status !== 'setup';
    arc.stages.splice(i, 1);
    if (!started) return;
    if (i < arc.current) {
        // A finished stage was removed: the current one simply shifts up.
        arc.stageStarts.splice(i, 1);
        arc.current--;
    } else if (i === arc.current && arc.status !== 'done') {
        // The current stage was removed: the next one starts now.
        if (arc.current >= arc.stages.length) {
            arc.current = arc.stages.length - 1;
            arc.status = 'done';
        } else {
            arc.stageStarts[arc.current] = progress(arc);
            arc.lastJudge = progress(arc);
        }
    }
    arc.stageStarts.length = Math.min(arc.stageStarts.length, arc.current + 1);
    if (arc.status === 'done') arc.current = arc.stages.length - 1;
    pushLog(arc, true, `${i + 1}단계 삭제`);
}

function goBack(arc) {
    if (arc.status === 'done') {
        arc.status = 'running';
    } else if (arc.current > 0) {
        arc.current--;
        arc.stageStarts.length = arc.current + 1;
    }
    arc.lastJudge = progress(arc);
    pushLog(arc, true, `${arc.current + 1}단계로 되돌림`);
}

let judging = false;

async function maybeJudge(force = false) {
    const manual = force;
    const s = getSettings();
    const arc = hasChat() ? getArc() : null;
    if (!s.enabled || !arc || arc.status !== 'running' || arc.hold || judging) return;
    const p = progress(arc);
    if (!force) {
        if (p - arc.lastJudge < judgeInterval(arc)) return;
        if (ripeness(arc) < judgeGate(arc)) return;
    }
    const chatId = ctx().getCurrentChatId();
    judging = true;
    softRender();
    try {
        arc.lastJudge = p;
        console.log(LOG, 'judging chapter', arc.current + 1, 'at', p, manual ? '(manual)' : '(auto)');
        const res = await judgeStage(arc);
        console.log(LOG, 'judge result', res);
        if (ctx().getCurrentChatId() !== chatId) {
            console.warn(LOG, 'chat changed while judging; result dropped');
            toastr.info('판정 중에 채팅방이 바뀌어서 결과를 버렸어요', 'Slow Plot');
            return;
        }
        if (res.inner) arc.inner = { ...res.inner, at: progress(arc), seen: false };
        const tooEarly = res.done && ripeness(arc) < judgeGate(arc);
        if (res.regress && !res.done) {
            pushLog(arc, false, '뒤로 밀려났어요 — ' + res.reason, res.detail);
            goBack(arc);
            arc.stageStarts[arc.current] = progress(arc);   // the earlier chapter has to be earned again
            if (getSettings().stageToast !== false) toastr.warning(`깡통 마음이 닫혔어요… ${arc.current + 1}단계로 돌아갔어요`, 'Slow Plot');
        } else {
            pushLog(arc, res.done && !tooEarly, (res.done ? (tooEarly ? '이뤄졌지만 아직 이르니 조금 더 머물게요 — ' : '완료! ') : '아직이에요 — ') + res.reason, res.detail);
            if (res.done && !tooEarly) advance(arc);
            else if (manual) toastr.info(`판정 결과: ${res.done ? '이뤄졌지만 아직 이르대요' : '아직이래요'} — ${res.reason}`, 'Slow Plot');
        }
        save();
    } catch (err) {
        console.error(LOG, 'judge failed', err);
        pushLog(arc, false, '판정 실패: ' + err.message);
        toastr.warning('판정 실패: ' + err.message, 'Slow Plot');
    } finally {
        judging = false;
        updateInjection();
        if (activeTab === 'plot') softRender(); else { renderQuick(); if (editing < 0) render(); }
    }
}

// ---------- UI ----------

let busy = '';            // '', 'generate', 'translate'
let editing = -1;
let wiOpen = false;
let moreOpen = false;   // "더 세밀하게" fold on the plot tab
let advMoreOpen = false;   // "고급" fold on the settings tab

// What is switched on inside the folded section, so it is visible while folded.
function moreSummary(arc) {
    const s = arc.setup;
    const bits = [];
    if ((s.difficulty || 'normal') !== 'normal') bits.push(diff(arc).label);
    const opts = [['obstacles', '방해꾼'], ['innerHint', '속마음'], ['foreshadow', '복선'], ['breather', '숨 고르기'], ['autoEvent', '돌발']]
        .filter(([k]) => s[k]).map(([, l]) => l);
    if (opts.length) bits.push(opts.join('·'));
    const cast = String(s.castExtra || '').split(/[,，、]/).map(x => x.trim()).filter(Boolean).length;
    if (cast) bits.push(`등장인물 ${cast}명`);
    return bits.length ? `(${esc(bits.join(' · '))})` : '(난이도 · 추가 옵션 · 등장인물)';
}
let ideaOpen = false;

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

function chip(label, on, act, value) {
    return `<button type="button" class="sb-chip${on ? ' on' : ''}" data-act="${act}" data-value="${esc(value)}">${esc(label)}</button>`;
}

function heartSvg(fill, i) {
    const f = Math.max(0, Math.min(1, fill));
    const path = 'M12 21s-8-5-8-11.2A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 2.8C20 16 12 21 12 21z';
    const id = `sb_clip_${i}`;
    return `<svg class="sb-heart" viewBox="0 0 24 24" aria-hidden="true">
        <defs><clipPath id="${id}"><rect x="0" y="${24 - 24 * f}" width="24" height="24"></rect></clipPath></defs>
        <path d="${path}" class="sb-heart-bg"></path>
        <path d="${path}" class="sb-heart-fill" clip-path="url(#${id})"></path>
    </svg>`;
}

function renderSetup(arc) {
    const s = arc.setup;
    const moodChips = PRESETS.mood.map(v => chip(v, s.moods.includes(v), 'mood', v)).join('') + chip('+ 직접', s.moodCustomOn, 'moodCustom', '1');
    const lenChips = PRESETS.length.map(v => chip(String(v), !s.lengthCustom && Number(s.length) === v, 'length', v)).join('') + chip('직접', s.lengthCustom, 'lengthCustom', '1');
    const stageChips = PRESETS.stages.map(v => chip(v === 'auto' ? 'AI한테 맡길래' : `${v}단계`, !s.stageCustom && String(s.stageCount) === String(v), 'stageCount', v)).join('')
        + chip('직접', s.stageCustom, 'stageCustom', '1');
    const hasStages = arc.stages.length > 0;
    const locked = arc.status === 'running' || arc.status === 'paused' || arc.status === 'done';

    return `
    <div class="sb-card">
        ${true ? `
        <div class="sb-field">
            <p class="sb-label">어떤 이야기가 보고 싶어?</p>
            <textarea class="sb-input sb-textarea sb-plot" data-bind="plot" placeholder="예: 깡통이랑 깡캐는 옆집 빵집 사장끼리라 매일 티격태격해. 동네 축제 준비를 같이 맡게 되면서 투닥거리다가 점점 손발이 맞아갔으면 좋겠어">${esc(s.plot)}</textarea>
            ${renderIdeas(arc)}
        </div>
        <div class="sb-field">
            <label class="sb-label sb-block">결말은 이랬으면 <span class="sb-sub">(안 써도 돼요)</span>
                <input class="sb-input" data-bind="ending" placeholder="예: 축제 날 둘이 합작 빵을 내놓고 대박 남" value="${esc(s.ending)}">
            </label>
        </div>
        <div class="sb-field">
            <p class="sb-label">분위기 <span class="sb-sub">(여러 개 OK, 안 골라도 돼요)</span></p>
            <div class="sb-chips">${moodChips}</div>
            ${s.moodCustomOn ? `<input class="sb-input" data-bind="moodCustom" placeholder="원하는 분위기를 써주세요" value="${esc(s.moodCustom)}">` : ''}
        </div>
        <div class="sb-field">
            <label class="sb-label sb-block">꼭 지켜줬으면 하는 것 <span class="sb-sub">(안 써도 돼요)</span>
                <textarea class="sb-input sb-textarea" data-bind="memo" placeholder="예: 깡캐가 실수를 해도 깡통은 절대 깡캐 탓을 하지 않음">${esc(s.memo)}</textarea>
            </label>
        </div>
        <div class="sb-field">
            <p class="sb-label">몇 챗 동안? <span class="sb-sub">(봇 답변 기준. 내 메시지는 안 세요)</span></p>
            <div class="sb-chips">${lenChips}</div>
            ${s.lengthCustom ? `<input class="sb-input sb-num" type="number" min="5" step="5" data-bind="length" value="${esc(s.length)}">` : ''}
        </div>
        <div class="sb-field">
            <p class="sb-label">몇 단계로?</p>
            <div class="sb-chips">${stageChips}</div>
            ${s.stageCustom ? `<label class="sb-sub sb-block">단계 수 (2~15)<input class="sb-input sb-num" type="number" min="2" max="15" data-bind="stageCount" value="${esc(s.stageCount === 'auto' ? 10 : s.stageCount)}"></label>` : ''}
            ${s.stageCount !== 'auto' ? `<p class="sb-sub">평균 단계당 약 ${Math.round(Number(s.length) / Number(s.stageCount))}챗. 내용에 따라 AI가 길고 짧게 나눠줘요</p>` : ''}
        </div>
        ${renderRefs(arc)}
        <div class="sb-more">
            <button type="button" class="sb-fold-head" data-act="moreToggle" aria-expanded="${moreOpen}"><i class="fa-solid ${moreOpen ? 'fa-caret-down' : 'fa-caret-right'}"></i> 더 세밀하게 <span class="sb-sub">${moreSummary(arc)}</span></button>
            ${moreOpen ? `<div class="sb-more-body">
        <div class="sb-field">
            <p class="sb-label">깡통 난이도 <span class="sb-sub">(진행 중에도 바꿀 수 있어요)</span></p>
            <div class="sb-chips">${Object.entries(DIFFICULTY).map(([k, d]) => chip(d.label, (s.difficulty || 'normal') === k, 'difficulty', k)).join('')}</div>
            ${(s.difficulty || 'normal') === 'normal' ? '' : `<p class="sb-sub">${esc(diff(arc).hint)}</p>`}
        </div>
        <div class="sb-field">
            <p class="sb-label">추가 옵션</p>
            <div class="sb-chips">
                ${chip('방해꾼 등장', s.obstacles, 'obstacles', '1')}
                ${chip('속마음 힌트', s.innerHint, 'innerHint', '1')}
                ${chip('복선 심기', s.foreshadow, 'foreshadow', '1')}
                ${chip('숨 고르기 턴', s.breather, 'breather', '1')}
                ${chip('돌발 사건 자동', s.autoEvent, 'autoEvent', '1')}
            </div>
            ${s.obstacles ? `<label class="sb-sub sb-block">어떤 방해꾼? <span>(안 써도 돼요. 비우면 AI가 어울리는 걸 넣어요)</span>
                <input class="sb-input" data-bind="obstacleText" placeholder="예: 깡통 옛 약혼자가 돌아옴, 옆 동네 대형 베이커리 입점" value="${esc(s.obstacleText)}">
            </label>
            <p class="sb-sub">방해꾼은 과정을 새로 만들 때 줄거리에 들어가요</p>` : ''}
            ${s.innerHint ? '<p class="sb-sub">진행 중에 깡통 속마음 한 줄과 마음 온도를 보여줘요. 판정할 때 같이 갱신돼요</p>' : ''}
            ${s.foreshadow ? '<p class="sb-sub">다음 단계와 이어질 작은 디테일을 가끔(3답변에 한 번) 슬쩍 흘려요. 과정을 새로 만들 때 단계마다 복선이 생겨요</p>' : ''}
            ${s.breather ? `<label class="sb-sub sb-block">숨 고르기: 봇 답변 몇 개마다 한 번 쉴까요? <span>(2~20)</span>
                <input class="sb-input sb-num" type="number" min="2" max="20" data-bind="breatherEvery" value="${esc(s.breatherEvery)}">
            </label>` : ''}
            ${s.autoEvent ? '<p class="sb-sub">가끔(약 8답변에 한 번) 작은 돌발 사건이 저절로 생겨요. 진행 패널의 🎲 버튼으로 직접 굴릴 수도 있어요</p>' : ''}
        </div>
        ${renderCast(arc)}
            </div>` : ''}
        </div>
        <button type="button" class="sb-btn sb-primary" data-act="generate" ${busy ? 'disabled' : ''}>
            ${busy === 'generate' ? '<i class="fa-solid fa-spinner fa-spin"></i> 만드는 중…' : (hasStages ? '과정 다시 만들기' : '과정 만들기 ✦')}
        </button>
        ${locked ? '<p class="sb-sub sb-center">진행 중에 다시 만들면 처음부터 시작해요</p>' : ''}
        <button type="button" class="sb-btn sb-small sb-clear-inputs" data-act="clearInputs"><i class="fa-solid fa-eraser"></i> 입력한 내용 전부 비우기</button>
        ` : ''}
    </div>`;
}

function renderIdeas(arc) {
    const s = arc.setup;
    const spice = [['calm', '잔잔하게'], ['mid', '적당히'], ['wild', '파격적으로']]
        .map(([v, l]) => chip(l, s.ideaSpice === v, 'ideaSpice', v)).join('');
    const loading = busy === 'ideas';
    const cards = (arc.ideas || []).map((idea, i) => `
        <div class="sb-idea">
            <div class="sb-idea-head">
                <div class="sb-idea-title">${esc(idea.title)}</div>
                <button type="button" class="sb-idea-x" data-act="ideaDel" data-value="${i}" aria-label="이 카드 지우기"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="sb-idea-story">${esc(idea.story)}</div>
            ${idea.ending ? `<div class="sb-sub"><i class="fa-solid fa-flag-checkered"></i> ${esc(idea.ending)}</div>` : ''}
            ${idea.moods.length ? `<div class="sb-idea-tags">${idea.moods.map(m => `<span>${esc(m)}</span>`).join('')}</div>` : ''}
            <div class="sb-row">
                <button type="button" class="sb-btn sb-small" data-act="ideaReroll" data-value="${i}" ${busy ? 'disabled' : ''}>${busy === `reroll${i}` ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '<i class="fa-solid fa-rotate"></i> 다시'}</button>
                <button type="button" class="sb-btn sb-small" data-act="ideaMore" data-value="${i}" ${busy ? 'disabled' : ''}>${busy === `more${i}` ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '<i class="fa-solid fa-wand-magic-sparkles"></i> 비슷하게 더'}</button>
                <span class="sb-grow"></span>
                <button type="button" class="sb-btn sb-small sb-primary" data-act="ideaUse" data-value="${i}">이걸로</button>
            </div>
        </div>`).join('');
    return `
    <div class="sb-ideabox">
        <button type="button" class="sb-fold-head" data-act="ideaToggle" aria-expanded="${ideaOpen}"><i class="fa-solid ${ideaOpen ? 'fa-caret-down' : 'fa-caret-right'}"></i> <i class="fa-solid fa-dice"></i> 아이디어가 없다면? 추천받기</button>
        ${ideaOpen ? `<div class="sb-ideabody">
            <div class="sb-group">
                <label class="sb-sub sb-block" for="sb_idea_kw">키워드 <span>(안 써도 돼요)</span></label>
                <input id="sb_idea_kw" class="sb-input" data-bind="ideaKeywords" placeholder="예: 축제, 비밀, 라이벌" value="${esc(s.ideaKeywords)}">
            </div>
            <div class="sb-group">
                <p class="sb-sub">튀는 정도</p>
                <div class="sb-chips">${spice}</div>
            </div>
            <div class="sb-group">
                <p class="sb-sub">참고</p>
                <div class="sb-chips">${chip('최근 대화 반영', s.ideaUseChat, 'ideaUseChat', '1')}</div>
                <p class="sb-sub sb-hint">분위기 칩과 아래 "참고할 자료"도 같이 반영돼요</p>
            </div>
            ${renderIdeaMore(arc)}
            <button type="button" class="sb-btn sb-idea-go" data-act="ideaGo" ${busy ? 'disabled' : ''}>
                ${loading ? '<i class="fa-solid fa-spinner fa-spin"></i> 고민하는 중…' : `<i class="fa-solid fa-dice"></i> ${arc.ideas?.length ? '다른 아이디어 3개' : '아이디어 3개 받기'}`}
            </button>
            ${cards ? `<div class="sb-ideas">${cards}</div>
            <button type="button" class="sb-btn sb-small sb-clear-inputs" data-act="ideaClear"><i class="fa-solid fa-broom"></i> 추천 카드 전부 지우기</button>` : ''}
        </div>` : ''}
    </div>`;
}

let ideaMoreOpen = false;

function renderIdeaMore(arc) {
    const s = arc.setup;
    const picked = s.ideaTropes.length + (s.ideaEnding !== 'any') + (s.ideaFocus !== 'both') + (s.ideaAvoid.trim() ? 1 : 0);
    const tropeChips = PRESETS.tropes.map(v => chip(v, s.ideaTropes.includes(v), 'ideaTrope', v)).join('');
    const endChips = Object.entries(IDEA_ENDINGS).map(([k, [l]]) => chip(l, s.ideaEnding === k, 'ideaEnding', k)).join('');
    const focusChips = Object.entries(IDEA_FOCUS).map(([k, [l]]) => chip(l, s.ideaFocus === k, 'ideaFocus', k)).join('');
    return `
    <div class="sb-ideamore">
        <button type="button" class="sb-fold-head" data-act="ideaMoreToggle" aria-expanded="${ideaMoreOpen}"><i class="fa-solid ${ideaMoreOpen ? 'fa-caret-down' : 'fa-caret-right'}"></i> 더 자세히 고르기 <span class="sb-sub">${picked ? `(${picked}개 고름)` : '(클리셰 · 결말 · 시점 · 빼줘)'}</span></button>
        ${ideaMoreOpen ? `
        <div class="sb-ideabody">
            <div class="sb-group"><p class="sb-sub">넣고 싶은 클리셰 <span>(여러 개 OK)</span></p><div class="sb-chips">${tropeChips}</div></div>
            <div class="sb-group"><p class="sb-sub">결말 방향</p><div class="sb-chips">${endChips}</div></div>
            <div class="sb-group"><p class="sb-sub">누구 이야기?</p><div class="sb-chips">${focusChips}</div></div>
            <div class="sb-group">
                <label class="sb-sub sb-block" for="sb_idea_avoid">빼줘 <span>(이런 건 안 나왔으면)</span></label>
                <input id="sb_idea_avoid" class="sb-input" data-bind="ideaAvoid" placeholder="예: 누가 죽는 전개, 연애" value="${esc(s.ideaAvoid)}">
            </div>
            ${picked ? '<button type="button" class="sb-btn sb-small" data-act="ideaMoreReset">고른 것 전부 풀기</button>' : ''}
        </div>` : ''}
    </div>`;
}

function renderCast(arc) {
    const s = arc.setup;
    return `
    <div class="sb-field">
        <p class="sb-label">등장인물 <span class="sb-sub">(다인봇이면 이름을 쉼표로 써주세요)</span></p>
        <input class="sb-input" data-bind="castExtra" placeholder="예: 하루, 유키, 렌 (1인봇이면 비워도 돼요)" value="${esc(s.castExtra)}">
        ${wiCount(arc) ? '<button type="button" class="sb-btn sb-small sb-cast-wi" data-act="castFromWi"><i class="fa-solid fa-book"></i> 체크한 월드인포 항목 이름 불러오기</button>' : ''}
        <p class="sb-sub">과정 만들 때 이 사람들한테 골고루 이야기를 나눠주고, 단계별 "이끄는 인물" 칩으로도 떠요</p>
    </div>`;
}

function renderRefs(arc) {
    const c = ctx();
    const s = arc.setup;
    const linked = linkedBooks();
    const books = [...linked, ...allBooks().filter(b => !linked.includes(b))];
    if (!s.wiBook && linked.length) s.wiBook = linked[0];
    let entriesHtml = '';
    if (s.wiBook) {
        const entries = wiCache.get(s.wiBook);
        if (entries === undefined) { ensureBook(s.wiBook); entriesHtml = '<p class="sb-sub">불러오는 중…</p>'; }
        else if (entries === null) entriesHtml = '<p class="sb-sub">불러오는 중…</p>';
        else if (!entries.length) entriesHtml = '<p class="sb-sub">켜져 있는 항목이 없어요</p>';
        else {
            const picked = s.wi[s.wiBook] || [];
            entriesHtml = `
            <div class="sb-row">
                <button type="button" class="sb-btn sb-small" data-act="wiAll" data-value="1">전체 선택</button>
                <button type="button" class="sb-btn sb-small" data-act="wiAll" data-value="0">전체 해제</button>
            </div>
            <div class="sb-wi-list">
                ${entries.map(e => `
                <label class="sb-wi-item">
                    <input type="checkbox" data-wi="${e.uid}" ${picked.includes(e.uid) ? 'checked' : ''}>
                    <span class="sb-wi-name">${esc(e.label)}</span>
                    <span class="sb-sub">${e.content.length}자</span>
                </label>`).join('')}
            </div>`;
        }
    }
    return `
    <div class="sb-field">
        <p class="sb-label">참고할 자료 <span class="sb-sub">(과정 만들 때 AI가 읽어요)</span></p>
        <div class="sb-chips">
            ${chip(`${c.name2} 캐릭터 설정`, s.useChar, 'useChar', '1')}
            ${chip(`${c.name1} 페르소나`, s.usePersona, 'usePersona', '1')}
            ${chip('최근 대화 반영', s.planUseChat, 'planUseChat', '1')}
            ${chip('요약 반영', s.useSummary !== false, 'useSummary', '1')}
        </div>
        ${s.useSummary !== false ? `<p class="sb-sub">${summaryNote()}</p>` : ''}
        ${s.planUseChat || s.ideaUseChat ? `<div class="sb-chatcount">
            <label class="sb-inline">최근 메시지 몇 개 읽을까?
                <input class="sb-input sb-num" type="number" min="1" max="100" data-bind="chatCount" value="${esc(s.chatCount)}">
            </label>
            <span class="sb-sub">1~100 · 내 메시지 포함 · 아이디어 추천에도 써요</span>
        </div>` : ''}
        <div class="sb-wi">
            <button type="button" class="sb-fold-head" data-act="wiToggle" aria-expanded="${wiOpen}"><i class="fa-solid ${wiOpen ? 'fa-caret-down' : 'fa-caret-right'}"></i> 월드인포 고르기 <span class="sb-sub sb-wi-count">(${wiCount(arc)}개 선택됨)</span></button>
            <p class="sb-sub sb-wi-picked">${wiPickedHtml(arc)}</p>
            ${!wiOpen ? '' : books.length ? `
            <div class="sb-chips sb-wi-books">${wiBookChipsHtml(arc)}</div>
            <select class="sb-input" data-wibook>
                <option value="">${Object.keys(s.wi).length ? '+ 다른 로어북 열기' : '로어북 고르기'}</option>
                ${books.map(b => `<option value="${esc(b)}" ${b === s.wiBook ? 'selected' : ''}>${linked.includes(b) ? '★ ' : ''}${esc(b)}${s.wi[b]?.length ? ` (${s.wi[b].length})` : ''}</option>`).join('')}
            </select>
            <p class="sb-sub">★ 표시는 이 캐릭터나 채팅에 연결된 로어북이에요. 로어북을 바꿔 가며 여러 개에서 골라도 다 같이 들어가요</p>
            ${entriesHtml}` : '<p class="sb-sub">로어북이 없어요</p>'}
        </div>
    </div>`;
}

// Finished stages and the one in progress stay put; only upcoming ones move.
function firstMovable(arc) {
    return arc.status === 'draft' || arc.status === 'setup' ? 0 : arc.current + 1;
}

function moveStage(arc, from, dir) {
    const to = from + dir;
    const min = firstMovable(arc);
    if (from < min || to < min || to >= arc.stages.length) return false;
    [arc.stages[from], arc.stages[to]] = [arc.stages[to], arc.stages[from]];
    return true;
}

// Stages the user tapped to peek at while hiding is on (this session only).
const peeked = new Set();

// The settings switch is the default; the chip in the progress tab overrides it for this chat only.
function hidingOn(arc) {
    return typeof arc?.hideStages === 'boolean' ? arc.hideStages : !!getSettings().hideStages;
}

function stageHidden(arc, i) {
    if (!hidingOn(arc) || peeked.has(i)) return false;
    const done = arc.status === 'done' || (arc.status !== 'draft' && i < arc.current);
    return !done;
}

function stageTitle(arc, i) {
    return stageHidden(arc, i) ? '' : ` 「${arc.stages[i]?.title_ko || ''}」`;
}

function renderStage(arc, st, i) {
    const running = arc.status !== 'draft';
    const isCur = running && i === arc.current && arc.status !== 'done';
    const isDone = running && (i < arc.current || arc.status === 'done');
    const hidden = editing !== i && stageHidden(arc, i);
    const cls = isCur ? 'cur' : (isDone ? 'done' : '');

    if (editing === i) {
        return `
        <div class="sb-stage edit">
            <div class="sb-edit">
                <label class="sb-sub sb-block">제목<input class="sb-input" data-edit="title_ko" value="${esc(st.title_ko)}"></label>
                <label class="sb-sub sb-block">내용<textarea class="sb-input sb-textarea" data-edit="summary_ko">${esc(st.summary_ko)}</textarea></label>
                <div class="sb-group">
                    <label class="sb-sub sb-block" for="sb_lead_${i}">이 단계를 이끄는 인물 <span>(비우면 자유)</span></label>
                    <input id="sb_lead_${i}" class="sb-input" data-edit="lead" placeholder="예: ${esc(castNames()[0] || '깡통')}" value="${esc(st.lead || '')}">
                    <div class="sb-chips">${castNames().map(n => `<button type="button" class="sb-chip" data-act="pickLead" data-value="${esc(n)}">${esc(n)}</button>`).join('')}</div>
                </div>
                <label class="sb-sub sb-block">이 단계 분위기 <span>(비우면 전체 분위기만)</span>
                    <input class="sb-input" data-edit="mood_ko" placeholder="예: 달달 → 불안" value="${esc(st.mood_ko || '')}">
                </label>
                <label class="sb-sub sb-block">이 단계 챗 수 <span>(비우면 자동 · 지금 계획 약 ${displayBudgets(arc)[i] ?? '?'}챗)</span>
                    <input class="sb-input sb-num" type="number" min="1" max="2000" data-edit="chats" placeholder="자동" value="${isFixed(st) ? esc(st.chats) : ''}">
                </label>
                <details class="sb-en">
                    <summary>AI가 실제로 읽는 문장 (영어)</summary>
                    <label class="sb-sub sb-block">Title<input class="sb-input" data-edit="title_en" value="${esc(st.title_en)}"></label>
                    <label class="sb-sub sb-block">Guide<textarea class="sb-input sb-textarea" data-edit="guide_en">${esc(st.guide_en)}</textarea></label>
                    <label class="sb-sub sb-block">복선 (Foreshadowing seed)<textarea class="sb-input sb-textarea" data-edit="seed_en">${esc(st.seed_en || '')}</textarea></label>
                    <p class="sb-sub">한국어만 고치면 영어는 저장할 때 자동으로 다시 번역돼요. 영어를 직접 고치면 그대로 써요.</p>
                </details>
                <div class="sb-row">
                    <button type="button" class="sb-btn sb-small" data-act="move" data-value="-1" aria-label="위로"><i class="fa-solid fa-arrow-up"></i></button>
                    <button type="button" class="sb-btn sb-small" data-act="move" data-value="1" aria-label="아래로"><i class="fa-solid fa-arrow-down"></i></button>
                    <button type="button" class="sb-btn sb-small sb-danger" data-act="delStage">삭제</button>
                    <span class="sb-grow"></span>
                    <button type="button" class="sb-btn sb-small" data-act="cancelEdit">취소</button>
                    <button type="button" class="sb-btn sb-small sb-primary" data-act="saveEdit" ${busy ? 'disabled' : ''}>${busy === 'translate' ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '저장'}</button>
                </div>
            </div>
        </div>`;
    }
    const minIdx = firstMovable(arc);
    const budgets = displayBudgets(arc);
    const canUp = i - 1 >= minIdx && i >= minIdx;
    const canDown = i >= minIdx && i + 1 < arc.stages.length;
    return `
    <div class="sb-stage ${cls}">
        ${arc.stages.length > 1 && arc.status !== 'done' ? `<div class="sb-move">
            <button type="button" class="sb-move-btn" data-act="moveAt" data-value="${i}:-1" aria-label="${i + 1}단계 위로" ${canUp ? '' : 'disabled'}><i class="fa-solid fa-chevron-up"></i></button>
            <button type="button" class="sb-move-btn" data-act="moveAt" data-value="${i}:1" aria-label="${i + 1}단계 아래로" ${canDown ? '' : 'disabled'}><i class="fa-solid fa-chevron-down"></i></button>
        </div>` : ''}
        <span class="sb-num-badge">${isDone ? '<i class="fa-solid fa-check"></i>' : i + 1}</span>
        <div class="sb-stage-text">
            <div class="sb-stage-title">${hidden ? '🔒 ???' : esc(st.title_ko || '(제목 없음)')}</div>
            ${hidden
                ? `<button type="button" class="sb-stage-sum sb-peek" data-act="peekStage" data-value="${i}">스포일러 방지로 가려져 있어요 · 눌러서 잠깐 보기</button>`
                : `<div class="sb-stage-sum">${isDone && !isCur ? '완료!' : esc(st.summary_ko)}${hidingOn(arc) && peeked.has(i) && !isDone ? ` <button type="button" class="sb-rehide" data-act="peekStage" data-value="${i}">다시 가리기</button>` : ''}</div>`}
            ${budgets[i] != null || st.mood_ko || st.lead ? `<div class="sb-stage-chats">${st.lead && !hidden ? `<span class="sb-stage-mood sb-stage-lead"><i class="fa-solid fa-user"></i> ${esc(st.lead)}</span>` : ''}${st.mood_ko && !hidden ? `<span class="sb-stage-mood">${esc(st.mood_ko)}</span>` : ''}${budgets[i] != null ? `${isFixed(st) ? '<i class="fa-solid fa-thumbtack"></i> ' : '약 '}${budgets[i]}챗` : ''}</div>` : ''}
        </div>
        <div class="sb-stage-btns">
            <button type="button" class="sb-icon" data-act="edit" data-value="${i}" aria-label="${i + 1}단계 수정"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="sb-icon sb-icon-del" data-act="delStageAt" data-value="${i}" aria-label="${i + 1}단계 삭제"><i class="fa-solid fa-trash-can"></i></button>
        </div>
    </div>`;
}

function renderProgress(arc) {
    if (!arc.stages.length) return '';
    const n = arc.stages.length;
    const s = getSettings();
    const p = progress(arc);
    const r = arc.status === 'draft' ? 0 : effRipeness(arc);
    const hearts = arc.stages.map((_, i) => {
        let fill = 0;
        if (arc.status === 'done' || (arc.status !== 'draft' && i < arc.current)) fill = 1;
        else if (arc.status !== 'draft' && i === arc.current) fill = Math.min(r, 1) * 0.9;
        return heartSvg(fill, i);
    }).join('');

    let status = '';
    if (arc.status === 'draft') status = '마음에 안 드는 단계는 고친 다음 <b>시작</b>을 눌러요';
    else if (arc.status === 'done') status = '모든 단계 완료! 이야기가 끝까지 왔어요';
    else {
        const toJudge = Math.max(0, judgeInterval(arc) - (p - arc.lastJudge));
        const minLeft = Math.max(0, Math.ceil(stageBudget(arc) * judgeGate(arc) - (p - stageStart(arc))));
        const judgeText = judging ? '지금 판정하는 중… (모델에 따라 1분쯤 걸려요)' : `다음 판정까지 ${Math.max(minLeft, toJudge, 1)}챗`;
        if (arc.status === 'paused') {
            status = `<b>${arc.current + 1}단계에서 일시정지 중</b><br>AI한테 아무것도 안 보내고, 멈춘 동안의 챗은 세지 않아요`;
        } else if (arc.hold) {
            status = `<b>${arc.current + 1}단계에 머무는 중</b><br>분위기는 계속 깔아두고, 다음 단계로는 넘어가지 않아요`;
        } else {
            status = `${arc.current + 1}단계 ${phaseLabel(r)} · ${judgeText}`;
            const extras = [];
            if (isBreather(arc, p + 1)) extras.push('다음 답변은 숨 고르기');
            else {
                if (arc.eventPending) extras.push('🎲 다음 답변에 돌발 사건');
                if (arc.nudgePending) extras.push('👉 다음 답변에 살짝 밀기');
            }
            if (extras.length) status += `<br>${extras.join(' · ')}`;
        }
    }

    const main = arc.status === 'draft'
        ? '<button type="button" class="sb-btn sb-primary" data-act="start">시작 ♥</button>'
        : arc.status === 'paused'
            ? '<button type="button" class="sb-btn sb-paused" data-act="resume"><i class="fa-solid fa-play"></i> 다시 시작</button>'
            : arc.status === 'done' ? '' : '<button type="button" class="sb-btn" data-act="pause"><i class="fa-solid fa-pause"></i> 일시정지</button>';

    const controls = arc.status === 'draft' ? `<div class="sb-ctrl one">${main}</div>` : `
        <div class="sb-ctrl">
            ${main}
            <button type="button" class="sb-btn" data-act="prev" ${arc.current === 0 && arc.status !== 'done' ? 'disabled' : ''}>이전 단계</button>
            <button type="button" class="sb-btn" data-act="next" ${arc.status === 'done' ? 'disabled' : ''}>다음 단계</button>
        </div>
        <div class="sb-ctrl two">
            <button type="button" class="sb-btn${arc.hold ? ' sb-holding' : ''}" data-act="hold" ${arc.status !== 'running' ? 'disabled' : ''}>
                <i class="fa-solid ${arc.hold ? 'fa-lock-open' : 'fa-thumbtack'}"></i> ${arc.hold ? '머물기 끝내기' : '이 단계에 머물기'}
            </button>
            <button type="button" class="sb-btn" data-act="judgeNow" ${judging || arc.status !== 'running' || arc.hold ? 'disabled' : ''}>${judging ? '<i class="fa-solid fa-spinner fa-spin"></i> 판정하는 중…' : '지금 판정하기'}</button>
        </div>
        <div class="sb-ctrl two">
            <button type="button" class="sb-btn${arc.nudgePending ? ' sb-holding' : ''}" data-act="nudge" ${arc.status !== 'running' || arc.hold ? 'disabled' : ''}>
                <i class="fa-solid fa-hand-point-right"></i> ${arc.nudgePending ? '밀기 대기 중' : '한 번만 살짝 밀기'}
            </button>
            <button type="button" class="sb-btn${arc.eventPending ? ' sb-holding' : ''}" data-act="rollEvent" ${arc.status !== 'running' ? 'disabled' : ''}>
                <i class="fa-solid fa-dice"></i> ${arc.eventPending ? '돌발 대기 중' : '돌발 사건 굴리기'}
            </button>
        </div>
        <div class="sb-ctrl one">
            <button type="button" class="sb-btn" data-act="preview">AI한테 가는 문장 보기</button>
        </div>`;

    return `
    <div class="sb-card">
        <div class="sb-card-row">
            <p class="sb-label sb-m0">${arc.status === 'draft' ? '이런 과정은 어때?' : '지금 여기까지 왔어'}</p>
            <span class="sb-sub">${arc.status === 'draft' ? `${arc.setup.length}챗` : `${p} / ${arc.setup.length}챗`}</span>
        </div>
        <div class="sb-hearts">${hearts}</div>
        <div class="sb-status">${status}</div>
        <div class="sb-hide-row"><button type="button" class="sb-chip${hidingOn(arc) ? ' on' : ''}" data-act="toggleHide">${hidingOn(arc) ? '🙈 이 방은 단계 가리는 중' : '👀 이 방은 단계 다 보이는 중'}</button></div>
        ${renderInner(arc)}
        <div class="sb-stages">${arc.stages.map((st, i) => renderStage(arc, st, i)).join('')}</div>
        <div class="sb-ctrl two">
            <button type="button" class="sb-btn sb-dashed" data-act="addStage">+ 단계 추가</button>
            <button type="button" class="sb-btn sb-dashed sb-danger-dashed" data-act="clearStages"><i class="fa-solid fa-trash-can"></i> 단계 전부 지우기</button>
        </div>
    </div>
    ${controls}`;
}


function renderInner(arc) {
    if (!arc.setup.innerHint || arc.status === 'draft' || arc.status === 'setup') return '';
    const { name2 } = ctx();
    const inner = arc.inner;
    const w = inner?.warmth;
    const peeking = busy === 'inner';
    return `
    <div class="sb-inner">
        <div class="sb-card-row">
            <span class="sb-inner-title"><i class="fa-solid fa-cloud"></i> ${esc(name2)} 속마음</span>
            ${Number.isFinite(w) ? `<span class="sb-sub">마음 온도 ${w}°</span>` : ''}
        </div>
        ${Number.isFinite(w) ? `<div class="sb-meter" role="img" aria-label="마음 온도 ${w}"><span style="width:${w}%"></span></div>` : ''}
        ${inner
            ? `<button type="button" class="sb-inner-text ${inner.seen ? '' : 'sb-blur'}" data-act="innerReveal" aria-label="속마음 보기">“${esc(inner.text)}”</button>
               ${inner.seen ? '' : '<p class="sb-sub sb-center sb-inner-new">💌 새 속마음이 왔어요! 스포일러 방지, 눌러서 보기</p>'}
               <p class="sb-sub sb-center">${inner.at}챗째에 엿본 마음</p>`
            : '<p class="sb-sub sb-center">아직 몰라요. 판정할 때 같이 알아내거나, 지금 엿볼 수 있어요</p>'}
        <button type="button" class="sb-btn sb-small" data-act="innerPeek" ${busy ? 'disabled' : ''}>
            ${peeking ? '<i class="fa-solid fa-spinner fa-spin"></i> 엿보는 중…' : '<i class="fa-solid fa-eye"></i> 지금 속마음 엿보기'}
        </button>
    </div>`;
}

let openLog = -1;

let prefDraft = '';
let prefDraftFreq = 'mid';
let prefEditing = null;   // id of the point being edited
let prefOpen = null;      // id whose AI reading is unfolded

function prefFreqChips(cur, id) {
    return Object.entries(PREF_FREQ).map(([k, f]) => `<button type="button" class="sb-chip${cur === k ? ' on' : ''}" data-act="prefFreq" data-value="${id}:${k}">${f.label}</button>`).join('');
}

function renderPrefCard(arc, p) {
    const busyHere = busy === `pref${p.id}`;
    if (prefEditing === p.id) {
        return `
        <div class="sb-pref edit">
            <textarea class="sb-input sb-textarea" data-pref-edit="${p.id}">${esc(p.text)}</textarea>
            <div class="sb-row">
                <button type="button" class="sb-btn sb-small" data-act="prefCancel">취소</button>
                <span class="sb-grow"></span>
                <button type="button" class="sb-btn sb-small sb-primary" data-act="prefSave" data-value="${p.id}" ${busy ? 'disabled' : ''}>${busyHere ? '<i class="fa-solid fa-spinner fa-spin"></i> 풀어 쓰는 중…' : '저장'}</button>
            </div>
        </div>`;
    }
    const open = prefOpen === p.id;
    return `
    <div class="sb-pref${p.on === false ? ' off' : ''}">
        <div class="sb-pref-head">
            <span class="sb-pref-label">${esc(p.label || p.text.slice(0, 20))}</span>
            <label class="sb-switch sb-switch-sm" title="이 포인트 켜기/끄기"><input type="checkbox" data-pref-on="${p.id}" ${p.on !== false ? 'checked' : ''}><span class="sb-track"><span class="sb-knob"></span></span></label>
        </div>
        <p class="sb-pref-text">${esc(p.text)}</p>
        <div class="sb-chips">${prefFreqChips(p.freq || 'mid', p.id)}</div>
        ${p.failed ? '<p class="sb-sub sb-warn">AI가 풀어 쓰지 못해서 적은 문장 그대로 넣고 있어요. 다시 풀어 쓰기를 눌러보세요</p>' : ''}
        <div class="sb-row">
            <button type="button" class="sb-btn sb-small" data-act="prefShow" data-value="${p.id}">${open ? '접기 ▴' : 'AI가 이해한 내용 ▾'}</button>
            <span class="sb-grow"></span>
            <button type="button" class="sb-icon" data-act="prefRedo" data-value="${p.id}" aria-label="다시 풀어 쓰기" ${busy ? 'disabled' : ''}>${busyHere ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '<i class="fa-solid fa-rotate"></i>'}</button>
            <button type="button" class="sb-icon" data-act="prefEdit" data-value="${p.id}" aria-label="고치기"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="sb-icon sb-icon-del" data-act="prefDel" data-value="${p.id}" aria-label="지우기"><i class="fa-solid fa-trash-can"></i></button>
        </div>
        ${open ? `<div class="sb-pref-ai">
            <p><b>늘 알고 있는 것</b>${esc(withNames(p.aware || p.text))}</p>
            ${p.surface ? `<p><b>묻어날 때</b>${esc(withNames(p.surface))}</p>` : ''}
            ${p.avoid ? `<p><b>피할 것</b>${esc(withNames(p.avoid))}</p>` : ''}
        </div>` : ''}
    </div>`;
}

function renderPrefs(arc) {
    const on = arc.prefsOn !== false;
    return `
    <div class="sb-card">
        <label class="sb-switch-line">
            <span><b>💗 내 취향 포인트</b><span class="sb-sub sb-block">이 채팅방에만 적용돼요</span></span>
            <span class="sb-switch"><input id="sb_prefs_on" type="checkbox" ${on ? 'checked' : ''}><span class="sb-track"><span class="sb-knob"></span></span></span>
        </label>
        <p class="sb-sub">좋아하는 포인트를 적어두면 깡통이 늘 알고 있다가, 어울리는 장면에서만 가끔 한 줄씩 자연스럽게 묻어나게 해줘요. 매번 꺼내거나 과하게 묘사하지 않고, 적은 문장을 그대로 따라 하지도 않아요. 단계 진행이랑 상관없이 따로 쓸 수 있어요.</p>
        <div class="sb-pref-add">
            <textarea class="sb-input sb-textarea" data-pref-draft placeholder="예: 깡캐는 40대, 깡통은 20대. 세대 차이가 자연스럽게 묻어났으면&#10;외모, 나이, 성격, 말투, 관계, 19금 취향까지 뭐든 편하게 적어요">${esc(prefDraft)}</textarea>
            <div class="sb-chips">${prefFreqChips(prefDraftFreq, 'new')}</div>
            <button type="button" class="sb-btn sb-primary" data-act="prefAdd" ${busy ? 'disabled' : ''}>${busy === 'prefnew' ? '<i class="fa-solid fa-spinner fa-spin"></i> AI가 풀어 쓰는 중…' : '포인트 추가 ✦'}</button>
            <p class="sb-sub">늘 알고는 있고, 은은하게는 약 8답변, 가끔은 약 5답변, 자주는 약 3~4답변에 한 번 "어울리면 한 줄" 신호가 가요. 안 어울리면 그냥 넘어가요</p>
        </div>
        ${arc.prefs.length ? `<div class="sb-prefs">${arc.prefs.map(p => renderPrefCard(arc, p)).join('')}</div>` : ''}
        ${arc.prefs.length ? '<button type="button" class="sb-btn" data-act="prefPreview">AI한테 가는 문장 보기</button>' : ''}
    </div>`;
}

function renderLog(arc) {
    if (!arc.log.length && !judging) return '';
    return `
    <div class="sb-card">
        <p class="sb-label">판정 기록</p>
        ${judging ? '<div class="sb-log sb-log-pending"><i class="fa-solid fa-spinner fa-spin"></i> 판정하는 중… 결과가 오면 여기에 떠요</div>' : ''}
        ${arc.log.slice(0, 8).map((l, i) => l.detail
            ? `<button type="button" class="sb-log sb-log-btn ${l.ok ? 'ok' : ''}" data-act="logToggle" data-value="${i}" aria-expanded="${openLog === i}">
                <span>${l.at}챗 · ${esc(l.text)}</span>
                <span class="sb-log-more">${openLog === i ? '접기 ▴' : '자세히 ▾'}</span>
                ${openLog === i ? `<span class="sb-log-detail">${esc(l.detail)}</span>` : ''}
              </button>`
            : `<div class="sb-log ${l.ok ? 'ok' : ''}">${l.at}챗 · ${esc(l.text)}</div>`).join('')}
    </div>`;
}

function renderAdvanced() {
    const s = getSettings();
    return `
    <div class="sb-card sb-adv">
        ${true ? `
        <label class="sb-switch-line">
            <span><b>Slow Plot 켜기</b><span class="sb-sub sb-block">끄면 단계 지시도 판정도 멈춰요. 만든 과정은 그대로 남아요</span></span>
            <span class="sb-switch"><input id="sb_enabled" type="checkbox" ${s.enabled ? 'checked' : ''}><span class="sb-track"><span class="sb-knob"></span></span></span>
        </label>
        <label class="sb-switch-line">
            <span><b>단계 넘어갈 때 알림 띄우기</b><span class="sb-sub sb-block">끄면 저절로 넘어갈 때 화면 위 알림이 안 떠요. 판정 기록에는 그대로 남아요</span></span>
            <span class="sb-switch"><input id="sb_stage_toast" type="checkbox" ${s.stageToast !== false ? 'checked' : ''}><span class="sb-track"><span class="sb-knob"></span></span></span>
        </label>
        <label class="sb-switch-line">
            <span><b>단계 가리기 기본값 (스포 방지)</b><span class="sb-sub sb-block">아직 안 끝난 단계는 제목·내용을 가려요. 진행 탭의 👀/🙈 칩으로 채팅방마다 따로 바꿀 수 있어요</span></span>
            <span class="sb-switch"><input id="sb_hide_stages" type="checkbox" ${s.hideStages ? 'checked' : ''}><span class="sb-track"><span class="sb-knob"></span></span></span>
        </label>
        <label class="sb-sub sb-block">과정 만들기 · 판정에 쓸 API
            <select class="sb-input sb-wide" data-setting="profileId">
                <option value="">지금 채팅 연결 그대로</option>
                ${listProfiles().map(p => `<option value="${esc(p.id)}" ${s.profileId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
            <span class="sb-block">저렴한 모델의 연결 프로필을 고르면 판정 비용을 아낄 수 있어요. 채팅 연결은 그대로예요.</span>
        </label>
        <label class="sb-sub sb-block">판정 주기 (봇 답변 몇 개마다)
            <input class="sb-input sb-num" type="number" min="2" max="100" data-setting="judgeInterval" value="${s.judgeInterval}">
        </label>
        <label class="sb-sub sb-block">최소 머무르기 (단계별 배정량의 %)
            <input class="sb-input sb-num" type="number" min="0" max="100" step="5" data-setting="minRatio" value="${Math.round(s.minRatio * 100)}">
        </label>
        <label class="sb-sub sb-block">판정할 때 읽는 최근 메시지 수
            <input class="sb-input sb-num" type="number" min="4" max="60" data-setting="judgeWindow" value="${s.judgeWindow}">
        </label>
        ${renderPromptEditor()}
        <div class="sb-more">
            <button type="button" class="sb-fold-head" data-act="advMoreToggle" aria-expanded="${advMoreOpen}"><i class="fa-solid ${advMoreOpen ? 'fa-caret-down' : 'fa-caret-right'}"></i> 고급 <span class="sb-sub">(끼워 넣는 깊이 · 역할)</span></button>
            ${advMoreOpen ? `<div class="sb-more-body">
        <label class="sb-sub sb-block">끼워 넣는 깊이 (클수록 은근함)
            <input class="sb-input sb-num" type="number" min="0" max="30" data-setting="depth" value="${s.depth}">
        </label>
        <label class="sb-sub sb-block">역할
            <select class="sb-input" data-setting="role">
                ${['system', 'user', 'assistant'].map(r => `<option value="${r}" ${s.role === r ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
        </label>
            </div>` : ''}
        </div>
        <button type="button" class="sb-btn sb-danger" data-act="reset">이 채팅의 과정 지우기</button>
        ` : ''}
    </div>`;
}

let promptKey = 'inject';

function renderPromptEditor() {
    const s = getSettings();
    const info = PROMPT_INFO[promptKey];
    const custom = !!(s.prompts?.[promptKey] && s.prompts[promptKey].trim());
    const changed = Object.keys(s.prompts || {}).filter(k => s.prompts[k]?.trim());
    return `
    <div class="sb-prompt">
        <p class="sb-label sb-m0">프롬프트 고치기</p>
        <p class="sb-sub">AI가 읽는 문장이라 영어로 쓰는 걸 추천해요. 더 좋은 프롬프트를 만들면 내보내서 공유할 수 있어요.</p>
        <select class="sb-input sb-wide" data-promptkey>
            ${Object.entries(PROMPT_INFO).map(([k, v]) => `<option value="${k}" ${k === promptKey ? 'selected' : ''}>${esc(v.label)}${changed.includes(k) ? ' ✎' : ''}</option>`).join('')}
        </select>
        <textarea class="sb-input sb-textarea sb-prompt-text" data-prompt spellcheck="false">${esc(getPrompt(promptKey))}</textarea>
        <p class="sb-sub">쓸 수 있는 변수: ${info.vars.split(', ').map(v => `<code>{{${v}}}</code>`).join(' ')}</p>
        <p class="sb-sub">변수가 비어 있는 줄은 자동으로 빠져요.${info.fixed ? ' 답변 형식(JSON) 부분은 고장 나지 않게 맨 끝에 자동으로 붙어요.' : ''}</p>
        <p class="sb-sub sb-prompt-state">${custom ? '✎ 고친 프롬프트를 쓰는 중' : '기본 프롬프트를 쓰는 중'}</p>
        <div class="sb-ctrl">
            <button type="button" class="sb-btn sb-small" data-act="promptReset">기본값으로</button>
            <button type="button" class="sb-btn sb-small" data-act="promptExport">내보내기</button>
            <button type="button" class="sb-btn sb-small" data-act="promptImport">가져오기</button>
        </div>
    </div>`;
}

function exportPrompts() {
    const s = getSettings();
    const prompts = {};
    for (const [k, v] of Object.entries(s.prompts || {})) if (PROMPT_INFO[k] && v?.trim()) prompts[k] = v;
    return Object.keys(prompts).length ? JSON.stringify({ slow_plot_prompts: 1, prompts }, null, 2) : '';
}

function importPrompts(text) {
    const data = JSON.parse(String(text).trim());
    if (!data || data.slow_plot_prompts !== 1 || typeof data.prompts !== 'object') throw new Error('Slow Plot 프롬프트 형식이 아니에요');
    const next = {};
    for (const [k, v] of Object.entries(data.prompts)) {
        if (PROMPT_INFO[k] && typeof v === 'string' && v.trim()) next[k] = v;
    }
    if (!Object.keys(next).length) throw new Error('가져올 프롬프트가 없어요');
    return next;
}

// ---------- quick panel (opened from the wand menu) ----------

let quickOpen = false;

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('sb_wand_btn')) return;
    const item = document.createElement('div');
    item.id = 'sb_wand_btn';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.innerHTML = `${SNAIL_SVG.replace('sb-snail', 'sb-wand-icon')}<span>Slow Plot</span>`;
    menu.appendChild(item);
}

let quickPopup = null;
let quickEl = null;

// Shown through SillyTavern's own popup so it sits above everything on phones too.
function openQuick() {
    if (quickPopup) return;
    // Wait a tick so the wand menu finishes closing first.
    setTimeout(async () => {
        const c = ctx();
        quickEl = document.createElement('div');
        quickEl.id = 'sb_quick';
        quickEl.addEventListener('click', onQuickClick);
        quickOpen = true;
        renderQuick();
        quickPopup = new c.Popup(quickEl, c.POPUP_TYPE.TEXT, '', { okButton: '닫기' });
        try {
            await quickPopup.show();
        } catch (err) {
            console.error(LOG, 'quick panel failed', err);
        } finally {
            quickPopup = null;
            quickOpen = false;
            quickEl = null;
        }
    }, 0);
}

// Delegated + capture phase: keeps working even if the wand menu is rebuilt
// or another handler stops the click from bubbling.
document.addEventListener('click', e => {
    if (e.target?.closest?.('#sb_wand_btn')) openQuick();
}, true);
document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target?.closest?.('#sb_wand_btn')) { e.preventDefault(); openQuick(); }
}, true);

function renderQuick() {
    const box = quickEl;
    if (!quickOpen || !box) return;
    const arc = hasChat() ? getArc() : null;
    const live = arc && ['running', 'paused', 'done'].includes(arc.status) && arc.stages.length;
    let body = '<p class="sbq-empty">진행 중인 과정이 없어요.<br>확장 메뉴의 Slow Plot에서 과정을 만들고 시작해 주세요.</p>';
    if (live) {
        const st = arc.stages[arc.current];
        const p = progress(arc);
        const running = arc.status === 'running';
        let state;
        if (arc.status === 'done') state = '모든 단계 완료!';
        else if (arc.status === 'paused') state = '일시정지 중';
        else if (arc.hold) state = '이 단계에 머무는 중';
        else state = phaseLabel(effRipeness(arc));
        const flags = [];
        if (running && isBreather(arc, p + 1)) flags.push('다음 답변은 숨 고르기');
        if (arc.nudgePending) flags.push('👉 살짝 밀기 대기');
        if (arc.eventPending) flags.push('🎲 돌발 대기');
        if (judging) flags.push('판정하는 중…');
        const inner = arc.setup.innerHint && arc.inner ? `
            <button type="button" class="sbq-inner ${arc.inner.seen ? '' : 'sb-blur'}" data-quick="inner">${arc.inner.seen ? '💭' : '💌'} “${esc(arc.inner.text)}”${Number.isFinite(arc.inner.warmth) ? ` · ${arc.inner.warmth}°` : ''}</button>` : '';
        body = `
            <div class="sbq-stage">${arc.current + 1}/${arc.stages.length} · ${stageHidden(arc, arc.current) ? '🔒 ???' : esc(st?.title_ko || '')}</div>
            <div class="sbq-meta">${esc(state)} · ${p}/${arc.setup.length}챗</div>
            ${flags.length ? `<div class="sbq-flags">${flags.map(esc).join(' · ')}</div>` : ''}
            ${inner}
            <div class="sbq-grid">
                <button type="button" data-quick="nudge" class="${arc.nudgePending ? 'on' : ''}" ${running && !arc.hold ? '' : 'disabled'}>👉 ${arc.nudgePending ? '밀기 취소' : '살짝 밀기'}</button>
                <button type="button" data-quick="event" class="${arc.eventPending ? 'on' : ''}" ${running ? '' : 'disabled'}>🎲 ${arc.eventPending ? '돌발 취소' : '돌발 사건'}</button>
                <button type="button" data-quick="hold" class="${arc.hold ? 'on' : ''}" ${running ? '' : 'disabled'}>📌 ${arc.hold ? '머물기 끝' : '머물기'}</button>
                <button type="button" data-quick="judge" ${running && !arc.hold && !judging ? '' : 'disabled'}>${judging ? '⏳ 판정하는 중…' : '🔍 지금 판정'}</button>
                <button type="button" data-quick="pause" ${arc.status === 'done' ? 'disabled' : ''}>${arc.status === 'paused' ? '▶ 다시 시작' : 'Ⅱ 일시정지'}</button>
                <button type="button" data-quick="next" ${arc.status === 'done' ? 'disabled' : ''}>⏭ 다음 단계</button>
            </div>`;
    }
    box.innerHTML = `
        <div class="sbq-card" aria-label="Slow Plot 빠른 조작">
            <div class="sbq-head">
                ${SNAIL_SVG.replace('sb-snail', 'sbq-icon')}
                <span class="sbq-title">Slow Plot</span>
            </div>
            ${body}
        </div>`;
}

function onQuickClick(e) {
    const btn = e.target.closest('[data-quick]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.quick;
    if (act === 'close') { quickPopup?.completeCancelled?.(); return; }
    const arc = hasChat() ? getArc() : null;
    if (!arc) return;
    switch (act) {
        case 'inner': if (arc.inner) arc.inner.seen = true; break;
        case 'nudge': arc.nudgePending = !arc.nudgePending; break;
        case 'event': arc.eventPending = !arc.eventPending; break;
        case 'hold': toggleHold(arc); break;
        case 'pause': if (arc.status === 'paused') resumeArc(arc); else pauseArc(arc); break;
        case 'next': advance(arc, true); break;
        case 'judge':
            save();
            toastr.info('판정 시작! 모델에 따라 1분쯤 걸릴 수 있어요', 'Slow Plot');
            maybeJudge(true);
            renderQuick();
            return;
    }
    save();
    updateInjection();
    renderQuick();
    softRender();
}

let activeTab = 'plot';   // plot | progress | settings

function renderTabs(arc) {
    const tabs = [['plot', '📝 줄거리'], ['progress', '🐌 진행'], ['prefs', '💗 취향'], ['settings', '⚙️ 설정']];
    const prefCount = arc && arc.prefsOn !== false ? activePrefs(arc).length : 0;
    const badge = k => {
        if (k === 'progress' && arc && arc.stages.length) return ` <span class="sb-tab-badge">${arc.status === 'draft' ? '시작 전' : `${arc.current + 1}/${arc.stages.length}`}</span>`;
        if (k === 'prefs' && prefCount) return ` <span class="sb-tab-badge">${prefCount}</span>`;
        return '';
    };
    return `<div class="sb-tabs sb-tabs4" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" class="sb-tab${activeTab === k ? ' on' : ''}" aria-selected="${activeTab === k}" data-act="tab" data-value="${k}">${l}${badge(k)}</button>`).join('')}</div>`;
}

function render() {
    renderQuick();
    const body = document.getElementById('sb_body');
    if (!body) return;
    const s = getSettings();
    if (!hasChat()) {
        body.innerHTML = '<div class="sb-card sb-center sb-sub">채팅을 열면 여기서 줄거리 과정을 만들 수 있어요</div>';
        return;
    }
    const arc = getArc();
    let content;
    if (activeTab === 'progress') {
        content = arc.stages.length
            ? renderProgress(arc) + renderLog(arc)
            : '<div class="sb-card sb-center sb-sub">아직 과정이 없어요. 📝 줄거리 탭에서 과정을 만들어 주세요</div>';
    } else if (activeTab === 'settings') {
        content = renderAdvanced();
    } else if (activeTab === 'prefs') {
        content = renderPrefs(arc);
    } else {
        content = renderSetup(arc);
    }
    const off = s.enabled ? '' : `<div class="sb-off"><span>지금 꺼져 있어요. 깡통한테 아무것도 안 들어가요</span><button type="button" class="sb-btn sb-small" data-act="enableOn">켜기</button></div>`;
    body.innerHTML = off + renderTabs(arc) + content;
}

function setHideStages(on) {
    getSettings().hideStages = on;
    peeked.clear();
    ctx().saveSettingsDebounced();
    render();
}

function setEnabled(on) {
    getSettings().enabled = on;
    ctx().saveSettingsDebounced();
    updateInjection();
    render();
}

async function onPromptAction(act) {
    const c = ctx();
    const s = getSettings();
    if (act === 'promptReset') {
        delete s.prompts[promptKey];
        toastr.info(`「${PROMPT_INFO[promptKey].label}」 프롬프트를 기본값으로 되돌렸어요`, 'Slow Plot');
    } else if (act === 'promptExport') {
        const text = exportPrompts();
        if (!text) { toastr.info('고친 프롬프트가 없어요. 기본값은 따로 공유할 필요가 없어요', 'Slow Plot'); return; }
        try { await navigator.clipboard.writeText(text); toastr.success('복사했어요! 붙여넣어서 공유하면 돼요', 'Slow Plot'); } catch { /* clipboard may be blocked */ }
        await c.Popup.show.text('내보내기', `<p>아래 내용을 통째로 복사해서 공유하세요</p><pre class="sb-pre">${esc(text)}</pre>`);
        return;
    } else {
        const text = await c.Popup.show.input('프롬프트 가져오기', '공유받은 내용을 통째로 붙여넣어 주세요. 지금 고친 프롬프트는 덮어써져요.', '');
        if (!text) return;
        try {
            s.prompts = importPrompts(text);
            toastr.success(`${Object.keys(s.prompts).length}개 프롬프트를 가져왔어요`, 'Slow Plot');
        } catch (err) {
            toastr.error('가져오기 실패: ' + (err instanceof SyntaxError ? '내용이 잘렸거나 형식이 달라요' : err.message), 'Slow Plot');
            return;
        }
    }
    c.saveSettingsDebounced();
    updateInjection();
    render();
}

async function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const val = btn.dataset.value;
    if (act === 'tab') { activeTab = val; render(); return; }
    if (act.startsWith('pref')) { await onPrefClick(act, val); return; }
    if (act === 'toggleHide') {
        const arc = getArc();
        const next = !hidingOn(arc);
        // Matching the default again means "follow the default" for this chat.
        arc.hideStages = next === !!getSettings().hideStages ? undefined : next;
        peeked.clear();
        save();
        render();
        return;
    }
    if (act === 'peekStage') { const k = Number(val); if (peeked.has(k)) peeked.delete(k); else peeked.add(k); render(); return; }
    if (act === 'enableOn') { setEnabled(true); return; }
    if (act === 'wiToggle') { wiOpen = !wiOpen; render(); return; }
    if (act === 'wiBookOpen') {
        const arc = getArc();
        arc.setup.wiBook = val;
        save();
        ensureBook(val);
        render();
        return;
    }
    if (act === 'moreToggle') { moreOpen = !moreOpen; render(); return; }
    if (act === 'advMoreToggle') { advMoreOpen = !advMoreOpen; render(); return; }
    if (act === 'ideaToggle') { ideaOpen = !ideaOpen; render(); return; }
    if (act === 'logToggle') { openLog = openLog === Number(val) ? -1 : Number(val); render(); return; }
    if (act === 'ideaMoreToggle') { ideaMoreOpen = !ideaMoreOpen; render(); return; }
    if (act === 'promptReset' || act === 'promptExport' || act === 'promptImport') {
        await onPromptAction(act);
        return;
    }
    const arc = getArc();
    if (!arc) return;
    const su = arc.setup;
    const c = ctx();

    switch (act) {
        case 'mood': su.moods = su.moods.includes(val) ? su.moods.filter(m => m !== val) : [...su.moods, val]; break;
        case 'moodCustom': su.moodCustomOn = !su.moodCustomOn; break;
        case 'length': su.length = Number(val); su.lengthCustom = false; break;
        case 'lengthCustom': su.lengthCustom = true; break;
        case 'stageCount': su.stageCount = val === 'auto' ? 'auto' : Number(val); su.stageCustom = false; break;
        case 'stageCustom':
            su.stageCustom = true;
            if (su.stageCount === 'auto') su.stageCount = 10;
            break;
        case 'useChar': su.useChar = !su.useChar; break;
        case 'usePersona': su.usePersona = !su.usePersona; break;
        case 'castFromWi': {
            const labels = [];
            for (const [book, uids] of Object.entries(su.wi)) {
                for (const e of wiCache.get(book) || []) if (uids.includes(e.uid)) labels.push(e.label);
            }
            const have = su.castExtra.split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
            su.castExtra = [...new Set([...have, ...labels])].join(', ');
            toastr.info('항목 이름을 불러왔어요. 사람 이름이 아닌 건 지워주세요', 'Slow Plot');
            break;
        }
        case 'planUseChat': su.planUseChat = !su.planUseChat; break;
        case 'useSummary': su.useSummary = su.useSummary === false; break;
        case 'ideaSpice': su.ideaSpice = val; break;
        case 'difficulty': su.difficulty = val; break;
        case 'obstacles': su.obstacles = !su.obstacles; break;
        case 'innerHint': su.innerHint = !su.innerHint; break;
        case 'foreshadow': su.foreshadow = !su.foreshadow; break;
        case 'breather': su.breather = !su.breather; break;
        case 'autoEvent': su.autoEvent = !su.autoEvent; break;
        case 'pickLead': {
            const input = btn.closest('.sb-edit')?.querySelector('[data-edit="lead"]');
            if (input) input.value = val;
            return;
        }
        case 'nudge':
            arc.nudgePending = !arc.nudgePending;
            if (arc.nudgePending) toastr.info('👉 다음 답변에서 한 걸음 밀어줄게요', 'Slow Plot');
            break;
        case 'rollEvent':
            arc.eventPending = !arc.eventPending;
            if (arc.eventPending) toastr.info('🎲 다음 답변에 돌발 사건이 생겨요!', 'Slow Plot');
            break;
        case 'innerReveal': if (arc.inner) arc.inner.seen = true; break;
        case 'innerPeek': {
            busy = 'inner'; render();
            try {
                arc.inner = { ...(await peekInner(arc)), at: progress(arc), seen: true };   // asked for it, so show it
            } catch (err) {
                console.error(LOG, err);
                toastr.error('엿보기 실패: ' + err.message, 'Slow Plot');
            } finally { busy = ''; }
            break;
        }
        case 'ideaUseChat': su.ideaUseChat = !su.ideaUseChat; break;
        case 'ideaTrope': su.ideaTropes = su.ideaTropes.includes(val) ? su.ideaTropes.filter(t => t !== val) : [...su.ideaTropes, val]; break;
        case 'ideaEnding': su.ideaEnding = val; break;
        case 'ideaFocus': su.ideaFocus = val; break;
        case 'ideaMoreReset': Object.assign(su, { ideaTropes: [], ideaEnding: 'any', ideaFocus: 'both', ideaAvoid: '' }); break;
        case 'ideaMore': {
            const i = Number(val);
            const base = arc.ideas?.[i];
            if (!base) return;
            busy = `more${i}`; render();
            try {
                const more = await suggestIdeas(arc, 2, arc.ideas, base);
                arc.ideas = [base, ...more];
                toastr.info('맨 위 카드를 바탕으로 비슷한 버전 2개를 뽑았어요', 'Slow Plot');
            } catch (err) {
                console.error(LOG, err);
                toastr.error('추천 실패: ' + err.message, 'Slow Plot');
            } finally { busy = ''; }
            break;
        }
        case 'ideaGo': {
            busy = 'ideas'; render();
            try {
                arc.ideas = await suggestIdeas(arc, 3, arc.ideas || []);
            } catch (err) {
                console.error(LOG, err);
                toastr.error('추천 실패: ' + err.message + (err.spReply ? '' : ' (API 연결을 확인해 주세요)'), 'Slow Plot');
            } finally { busy = ''; }
            break;
        }
        case 'ideaReroll': {
            const i = Number(val);
            busy = `reroll${i}`; render();
            try {
                const [one] = await suggestIdeas(arc, 1, arc.ideas);
                arc.ideas[i] = one;
            } catch (err) {
                console.error(LOG, err);
                toastr.error('추천 실패: ' + err.message, 'Slow Plot');
            } finally { busy = ''; }
            break;
        }
        case 'ideaDel': arc.ideas.splice(Number(val), 1); break;
        case 'ideaClear': arc.ideas = []; break;
        case 'ideaUse': {
            const idea = arc.ideas?.[Number(val)];
            if (!idea) return;
            if (su.plot.trim() && su.plot.trim() !== idea.story) {
                const ok = await c.Popup.show.confirm('이 아이디어로 채우기', '지금 써둔 줄거리·결말·분위기가 바뀌어요. 괜찮아요?');
                if (!ok) return;
            }
            applyIdea(arc, idea);
            ideaOpen = false;
            toastr.success('채웠어요! 마음대로 고쳐도 돼요', 'Slow Plot');
            break;
        }
        case 'wiAll': {
            const entries = wiCache.get(su.wiBook) || [];
            su.wi[su.wiBook] = val === '1' ? entries.map(e => e.uid) : [];
            if (!su.wi[su.wiBook].length) delete su.wi[su.wiBook];
            break;
        }

        case 'generate': {
            if (!su.plot.trim()) { toastr.warning('보고 싶은 이야기를 먼저 써주세요', 'Slow Plot'); return; }
            if (arc.status !== 'setup') {
                const ok = await c.Popup.show.confirm('과정 다시 만들기', '지금 과정과 진행 상황이 사라지고 처음부터 시작해요. 괜찮아요?');
                if (!ok) return;
            }
            busy = 'generate'; render();
            try {
                await generateStages(arc);
                Object.assign(arc, { status: 'draft', current: 0, stageStarts: [], lastJudge: 0, log: [] });
                editing = -1;
                activeTab = 'progress';
                toastr.success('과정을 만들었어요! 마음에 안 드는 단계는 고쳐보세요', 'Slow Plot');
            } catch (err) {
                console.error(LOG, err);
                toastr.error('과정 만들기 실패: ' + err.message + (err.spReply ? '' : ' (API 연결을 확인해 주세요)'), 'Slow Plot');
            } finally { busy = ''; }
            break;
        }
        case 'start':
            if (editing >= 0) { toastr.info('수정 중인 단계를 먼저 저장해 주세요', 'Slow Plot'); return; }
            Object.assign(arc, { status: 'running', current: 0, baseIndex: ctx().chat.length, base: 0, countMode: 'idx', stageStarts: [0], lastJudge: 0, hold: false, frozenAt: null, log: [] });
            pushLog(arc, true, `1단계${stageTitle(arc, 0)} 시작`);
            break;
        case 'pause': pauseArc(arc); break;
        case 'resume': resumeArc(arc); break;
        case 'next': advance(arc, true); break;
        case 'prev': goBack(arc); break;
        case 'hold': toggleHold(arc); break;
        case 'judgeNow':
            save();
            toastr.info('판정 시작! 모델에 따라 1분쯤 걸릴 수 있어요', 'Slow Plot');
            maybeJudge(true);
            return;
        case 'preview': {
            const text = arc.status === 'running' ? buildInjection(arc) : '(지금은 아무것도 보내지 않아요. 진행 중일 때만 보내요)';
            await c.Popup.show.text('AI한테 가는 문장', `<pre class="sb-pre">${esc(text)}</pre>`);
            return;
        }
        case 'clearStages': {
            const ok = await c.Popup.show.confirm('단계 전부 지우기', '만들어진 단계와 진행 상황, 판정 기록을 한 번에 지울까요? 위에 써둔 줄거리 설정은 그대로 남아요.');
            if (!ok) return;
            Object.assign(arc, { stages: [], arcEn: null, status: 'setup', current: 0, base: 0, stageStarts: [], lastJudge: 0, hold: false, frozenAt: null, log: [] });
            editing = -1; activeTab = 'plot';
            toastr.info('단계를 전부 지웠어요', 'Slow Plot');
            break;
        }
        case 'clearInputs': {
            const ok = await c.Popup.show.confirm('입력한 내용 비우기', '줄거리, 결말, 분위기, 지켜줬으면 하는 것, 키워드, 추천 카드를 전부 비울까요? 만들어진 단계는 그대로 남아요.');
            if (!ok) return;
            Object.assign(su, { plot: '', ending: '', moods: [], moodCustom: '', moodCustomOn: false, memo: '', ideaKeywords: '' });
            arc.ideas = [];
            toastr.info('입력한 내용을 비웠어요', 'Slow Plot');
            break;
        }
        case 'reset': {
            const ok = await c.Popup.show.confirm('과정 지우기', '이 채팅의 줄거리 과정과 기록을 모두 지울까요?');
            if (!ok) return;
            c.chatMetadata[MODULE] = newArc();
            editing = -1; activeTab = 'plot';
            break;
        }

        case 'edit': editing = Number(val); break;
        case 'cancelEdit': editing = -1; break;
        case 'addStage':
            arc.stages.push({ title_ko: '', summary_ko: '', title_en: '', guide_en: '', suggested: null, chats: null });
            editing = arc.stages.length - 1;
            break;
        case 'delStage':
        case 'delStageAt': {
            const i = act === 'delStage' ? editing : Number(val);
            if (arc.stages.length <= 1) { toastr.warning('단계는 최소 하나는 있어야 해요', 'Slow Plot'); return; }
            const title = arc.stages[i]?.title_ko || `${i + 1}단계`;
            const ok = await c.Popup.show.confirm('단계 삭제', `「${title}」 단계를 지울까요?`);
            if (!ok) return;
            removeStage(arc, i);
            editing = -1;
            break;
        }
        case 'move': {
            if (!moveStage(arc, editing, Number(val))) {
                toastr.info('이미 지나갔거나 진행 중인 단계는 순서를 바꿀 수 없어요', 'Slow Plot');
                return;
            }
            editing += Number(val);
            break;
        }
        case 'moveAt': {
            const [from, dir] = String(val).split(':').map(Number);
            if (!moveStage(arc, from, dir)) return;
            break;
        }
        case 'saveEdit': {
            const box = btn.closest('.sb-edit');
            const get = k => box.querySelector(`[data-edit="${k}"]`).value.trim();
            const st = arc.stages[editing];
            st.seed_en = get('seed_en');
            const next = { title_ko: get('title_ko'), summary_ko: get('summary_ko'), title_en: get('title_en'), guide_en: get('guide_en') };
            st.lead = get('lead');
            const moodKo = get('mood_ko');
            if (moodKo !== (st.mood_ko || '')) { st.mood_ko = moodKo; st.mood_en = ''; }
            const chatsVal = Math.round(Number(get('chats')));
            st.chats = get('chats') && chatsVal > 0 ? chatsVal : null;
            if (!next.title_ko && !next.summary_ko) { toastr.warning('제목이나 내용을 써주세요', 'Slow Plot'); return; }
            const koChanged = next.title_ko !== st.title_ko || next.summary_ko !== st.summary_ko;
            const enChanged = next.title_en !== st.title_en || next.guide_en !== st.guide_en;
            Object.assign(st, next);
            if ((koChanged && !enChanged) || !st.guide_en) {
                busy = 'translate'; render();
                try { await translateStage(arc, st); } catch (err) {
                    console.error(LOG, err);
                    toastr.warning('영어 번역에 실패해서 한국어 그대로 보내요', 'Slow Plot');
                } finally { busy = ''; }
            }
            editing = -1;
            break;
        }
        default: return;
    }
    save();
    updateInjection();
    render();
}

async function onPrefClick(act, val) {
    const arc = getArc();
    const find = id => arc.prefs.find(p => p.id === id);
    const expandInto = async (p, key) => {
        busy = key; render();
        try {
            Object.assign(p, await expandPref(arc, p.text));
        } catch (err) {
            console.error(LOG, 'pref expand failed', err);
            Object.assign(p, { label: p.label || '', aware: '', surface: '', avoid: '', failed: true });
            toastr.warning('풀어 쓰기 실패: ' + err.message + ' · 일단 적은 문장 그대로 넣을게요', 'Slow Plot');
        } finally { busy = ''; }
    };
    switch (act) {
        case 'prefAdd': {
            const text = prefDraft.trim();
            if (!text) { toastr.warning('포인트를 먼저 적어주세요', 'Slow Plot'); return; }
            const p = { id: Date.now().toString(36), text, freq: prefDraftFreq, on: true };
            arc.prefs.push(p);
            prefDraft = '';
            prefDraftFreq = 'mid';
            await expandInto(p, 'prefnew');
            break;
        }
        case 'prefFreq': {
            const [id, f] = String(val).split(':');
            if (id === 'new') { prefDraftFreq = f; render(); return; }
            const p = find(id); if (p) p.freq = f;
            break;
        }
        case 'prefDel': {
            const p = find(val); if (!p) return;
            const ok = await ctx().Popup.show.confirm('포인트 지우기', `「${p.label || p.text.slice(0, 20)}」 포인트를 지울까요?`);
            if (!ok) return;
            arc.prefs = arc.prefs.filter(x => x.id !== val);
            break;
        }
        case 'prefEdit': prefEditing = val; render(); return;
        case 'prefCancel': prefEditing = null; render(); return;
        case 'prefSave': {
            const p = find(val); if (!p) return;
            const el = document.querySelector(`#sb_root [data-pref-edit="${val}"]`);
            const text = String(el?.value ?? '').trim();
            if (!text) { toastr.warning('내용을 적어주세요', 'Slow Plot'); return; }
            prefEditing = null;
            if (text !== p.text) { p.text = text; await expandInto(p, `pref${p.id}`); }
            break;
        }
        case 'prefRedo': {
            const p = find(val); if (!p) return;
            await expandInto(p, `pref${p.id}`);
            break;
        }
        case 'prefShow': prefOpen = prefOpen === val ? null : val; render(); return;
        case 'prefPreview': {
            const text = buildPrefInjection(arc) || '(켜져 있는 포인트가 없어요)';
            await ctx().Popup.show.text('AI한테 가는 문장 (취향)', `<pre class="sb-pre">${esc(text)}</pre>`);
            return;
        }
        default: return;
    }
    save();
    updateInjection();
    render();
}

function onInput(e) {
    const el = e.target;
    if (el.dataset.prefDraft !== undefined) { prefDraft = el.value; return; }
    if (el.dataset.prefOn !== undefined) {
        if (e.type !== 'change') return;
        const arc = getArc();
        const p = arc.prefs.find(x => x.id === el.dataset.prefOn);
        if (p) { p.on = el.checked; save(); updateInjection(); render(); }
        return;
    }
    if (el.id === 'sb_prefs_on') {
        if (e.type !== 'change') return;
        getArc().prefsOn = el.checked; save(); updateInjection(); render();
        return;
    }
    if (el.id === 'sb_enabled') { if (e.type === 'change') setEnabled(el.checked); return; }
    if (el.id === 'sb_hide_stages') { if (e.type === 'change') setHideStages(el.checked); return; }
    if (el.id === 'sb_stage_toast') {
        if (e.type === 'change') { getSettings().stageToast = el.checked; ctx().saveSettingsDebounced(); }
        return;
    }
    const arc = hasChat() ? getArc() : null;
    if (el.dataset.bind && arc) {
        const k = el.dataset.bind;
        if (k === 'length') arc.setup.length = Math.max(5, Number(el.value) || 100);
        else if (k === 'chatCount') arc.setup.chatCount = Math.min(100, Math.max(1, Math.round(Number(el.value) || 30)));
        else if (k === 'breatherEvery') arc.setup.breatherEvery = Math.min(20, Math.max(2, Math.round(Number(el.value) || 5)));
        else if (k === 'stageCount') arc.setup.stageCount = Math.min(15, Math.max(2, Math.round(Number(el.value) || 5)));
        else arc.setup[k] = el.value;
        save();
        return;
    }
    if (arc && el.dataset.wi !== undefined && e.type === 'change') {
        const uid = Number(el.dataset.wi);
        const book = arc.setup.wiBook;
        const list = new Set(arc.setup.wi[book] || []);
        if (el.checked) list.add(uid); else list.delete(uid);
        if (list.size) arc.setup.wi[book] = [...list]; else delete arc.setup.wi[book];
        save();
        const counter = document.querySelector('#sb_root .sb-wi-count');
        if (counter) counter.textContent = `(${wiCount(arc)}개 선택됨)`;
        const picked = document.querySelector('#sb_root .sb-wi-picked');
        if (picked) picked.innerHTML = wiPickedHtml(arc);
        const chips = document.querySelector('#sb_root .sb-wi-books');
        if (chips) chips.innerHTML = wiBookChipsHtml(arc);
        return;
    }
    if (arc && el.dataset.wibook !== undefined && e.type === 'change') {
        arc.setup.wiBook = el.value;
        save();
        ensureBook(el.value);
        render();
        return;
    }
    if (el.dataset.promptkey !== undefined && e.type === 'change') {
        promptKey = el.value;
        render();
        return;
    }
    if (el.dataset.prompt !== undefined && e.type === 'input') {
        const s = getSettings();
        if (el.value.trim() && el.value !== DEFAULT_PROMPTS[promptKey]) s.prompts[promptKey] = el.value;
        else delete s.prompts[promptKey];
        ctx().saveSettingsDebounced();
        updateInjection();
        const state = document.querySelector('#sb_root .sb-prompt-state');
        if (state) state.textContent = s.prompts[promptKey] ? '✎ 고친 프롬프트를 쓰는 중' : '기본 프롬프트를 쓰는 중';
        return;
    }
    if (el.dataset.setting) {
        const s = getSettings();
        const k = el.dataset.setting;
        if (k === 'role' || k === 'profileId') s[k] = el.value;
        else if (k === 'minRatio') s.minRatio = Math.min(100, Math.max(0, Number(el.value) || 0)) / 100;
        else s[k] = Math.max(0, Number(el.value) || 0);
        ctx().saveSettingsDebounced();
        updateInjection();
    }
}

function buildPanel() {
    const html = `
    <div id="sb_root" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${SNAIL_SVG.replace('sb-snail', 'sb-title-icon')} Slow Plot</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="sb-wrap">
                    <div id="sb_body"></div>
                </div>
            </div>
        </div>
    </div>`;
    document.getElementById('extensions_settings2').insertAdjacentHTML('beforeend', html);
    const root = document.getElementById('sb_root');
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
}

// Pink-shelled snail: the extension's mark ("slow").
const SNAIL_SVG = `<svg class="sb-snail" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M47 34 L44 18" stroke="#9B85E8" stroke-width="3.5" stroke-linecap="round"/><path d="M54 35 L57 20" stroke="#9B85E8" stroke-width="3.5" stroke-linecap="round"/><circle cx="44" cy="17" r="3.6" fill="#9B85E8"/><circle cx="57" cy="19" r="3.6" fill="#9B85E8"/><path d="M8 52 Q8 46 16 46 L46 46 Q50 34 56 38 Q62 42 60 50 Q59 55 52 55 L12 55 Q8 55 8 52Z" fill="#B9A8EE"/><circle cx="27" cy="32" r="17" fill="#FF8FB1"/><path d="M27 32 m0 -2 a2 2 0 1 1 -2 2 a5 5 0 0 1 5 -5 a8 8 0 0 1 8 8 a11 11 0 0 1 -11 11 a13 13 0 0 1 -13 -13" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="53" cy="44" r="1.8" fill="#4E36B0"/></svg>`;

// ---------- events ----------

// A pending surprise is spent by the reply that just arrived; auto mode may queue the next one.
function afterBotReply() {
    const arc = hasChat() ? getArc() : null;
    if (!arc || arc.status !== 'running') return;
    let changed = false;
    // A breather reply skips the event, so it stays queued for the next one.
    if (arc.eventPending && !isBreather(arc, progress(arc))) { arc.eventPending = false; changed = true; }
    if (arc.nudgePending && !isBreather(arc, progress(arc))) { arc.nudgePending = false; changed = true; }
    if (arc.setup.autoEvent && !arc.hold && Math.random() < AUTO_EVENT_CHANCE) { arc.eventPending = true; changed = true; }
    if (changed) save();
}

// Re-render from background events without wiping what the user is typing.
function softRender() {
    renderQuick();
    if (editing >= 0) return;
    if (document.activeElement?.closest?.('#sb_root .sb-input')) return;
    render();
}

function refresh() {
    editing = -1;
    prefEditing = null;
    prefOpen = null;
    prefDraft = '';
    peeked.clear();
    const arc = hasChat() ? getArc() : null;
    activeTab = arc && arc.stages.length ? 'progress' : 'plot';
    updateInjection();
    render();
}

(function init() {
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.APP_READY, () => {
        getSettings();
        buildPanel();
        addWandButton();
        refresh();
    });
    eventSource.on(event_types.CHAT_CHANGED, refresh);
    // Only the bot's own replies get the direction: background requests from other
    // extensions (translators, summaries: type 'quiet') and impersonation stay clean.
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type) => {
        if (type === 'quiet' || type === 'impersonate') {
            ctx().setExtensionPrompt(MODULE, '', PROMPT_NONE, 0);
            ctx().setExtensionPrompt(PREF_KEY, '', PROMPT_NONE, 0);
            return;
        }
        updateInjection();
    });
    eventSource.on(event_types.MESSAGE_SENT, () => { updateInjection(); softRender(); });
    eventSource.on(event_types.MESSAGE_DELETED, () => { updateInjection(); softRender(); });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        afterBotReply();
        updateInjection();
        softRender();
        maybeJudge();
    });
})();
