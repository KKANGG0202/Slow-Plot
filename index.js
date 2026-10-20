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
    judgeInterval: 10,   // check every N chats
    minRatio: 0.7,       // never advance before this share of the stage's budget
    depth: 4,            // injection depth in chat
    role: 'system',
    judgeWindow: 20,     // how many recent messages the judge reads
    profileId: '',       // connection profile for planning/judging; '' = current connection
    prompts: {},         // user overrides of DEFAULT_PROMPTS, keyed by prompt id
});

const PRESETS = {
    mood: ['피폐', '애틋', '달달', '긴장감', '미스터리', '일상', '코믹', '성장', '구원', '집착'],
    length: [200, 400, 800],
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
            length: 400, lengthCustom: false,
            stageCount: 'auto',
            stageCustom: false,
            ideaKeywords: '',
            ideaSpice: 'mid',  // calm | mid | wild
            ideaUseChat: true,
            difficulty: 'normal', // easy | normal | hard | hell
            obstacles: false,
            obstacleText: '',
            innerHint: false,
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
        frozenAt: null,       // message count when paused/held; those chats are not counted
        ideas: [],            // last story suggestions: { title, story, ending, moods[] }
        inner: null,          // { text, warmth, at } — char's hidden feelings, for the hint box
        log: [],
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
    const fresh = newArc();
    for (const k of Object.keys(fresh)) if (!Object.hasOwn(arc, k)) arc[k] = fresh[k];
    for (const k of Object.keys(fresh.setup)) if (!Object.hasOwn(arc.setup, k)) arc.setup[k] = fresh.setup[k];
    return arc;
}

function save() {
    ctx().saveMetadataDebounced();
}

// ---------- counting / pacing ----------

function messageCount() {
    return ctx().chat.filter(m => !m.is_system).length;
}

function isFrozen(arc) {
    return arc.status === 'paused' || (arc.hold && arc.status === 'running');
}

function progress(arc) {
    const now = arc.frozenAt != null ? arc.frozenAt : messageCount();
    return Math.max(0, now - arc.base);
}

// Pause and hold both freeze the pacing clock; chats written meanwhile are not counted.
function syncFreeze(arc) {
    if (isFrozen(arc) && arc.frozenAt == null) {
        arc.frozenAt = messageCount();
    } else if (!isFrozen(arc) && arc.frozenAt != null) {
        arc.base += Math.max(0, messageCount() - arc.frozenAt);
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

function stageBudget(arc) {
    const n = arc.stages.length;
    const remainingStages = Math.max(1, n - arc.current);
    const remainingChats = Math.max(0, Number(arc.setup.length) - stageStart(arc));
    return Math.max(6, Math.round(remainingChats / remainingStages));
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
        'Pacing: {{pacing}}',
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
        'Total length: about {{length}} chat messages.',
        'Number of chapters: {{chapter_count}}',
        '',
        'Guidelines:',
        '- Follow the user\'s outline faithfully, including dark or painful developments if that is what they asked for. This is fiction the user chose for their own story.',
        '- Each chapter is a phase of the story (situation, turning point, and its emotional aftermath), not a single scripted scene. It must be able to unfold gradually over many messages while leaving room for unrelated scenes and the user\'s own choices.',
        '- Build up to major events: show foreshadowing and setup before a turning point, and give its aftermath room to breathe. No abrupt jumps.',
        '- Respect the characters\' established personalities and the current situation of the roleplay.',
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
        'Characters:',
        '- {{char}}: {{char_description}}',
        '- {{user}}: {{persona}}',
        '{{world_info}}',
        '',
        '{{recent_chat}}',
        '',
        'Tone the user wants: {{tone}}',
        'Keywords to weave in: {{keywords}}',
        'Boldness: {{spice}}',
        '{{obstacles}}',
        'Already suggested (do not repeat or closely resemble these): {{avoid}}',
        '',
        'Guidelines:',
        '- Each idea must fit these specific characters, their situation and their world. Avoid generic plots that could apply to anyone.',
        '- Make the ideas clearly different from each other in premise and direction.',
        '- Give each idea a clear direction and an ending to head toward, while leaving room for the user\'s own choices along the way.',
    ].join('\n'),
    diffEasy: '{{char}} is fairly open to where the story is heading and meets {{user}} halfway.',
    diffHard: '{{char}} does not make this easy. {{char}} resists, deflects or pushes back, never moves toward the story\'s direction on their own, and only shifts, reluctantly and a little at a time, in response to what {{user}} actually does.',
    diffHell: '{{char}} is deeply resistant. {{char}} actively pushes {{user}} away, almost never takes a step forward on their own, and any softening is small, hard-won and easily lost again if {{user}} misjudges the moment.',
    judgeHard: '{{char}} is meant to be hard to win over. Only count the chapter as done if {{user}}\'s own actions have clearly worn down {{char}}\'s resistance.',
    judgeHell: '{{char}} is meant to be extremely hard to win over. Only count the chapter as done if {{user}} has clearly earned it through their own actions, and notice if things have slipped backwards.',
    obstacles: 'Include obstacles: bring in {{obstacle_detail}} and weave them into the chapters so they get in the way of the story\'s direction and raise the stakes.',
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
    'Return JSON only, in exactly this shape:',
    '{"arc":{"premise":"<the overall story in 1-2 English sentences>","ending":"<the destination in English, or empty>","tone":"<tone in English, one short phrase>","notes":"<things to keep, in English, or empty>","obstacles":"<the obstacle characters or situations in one English sentence, or empty>"},',
    ' "chapters":[{"title_ko":"<short Korean title>","summary_ko":"<one or two Korean sentences>","title_en":"<short English title>","guide_en":"<2-3 English sentences on what unfolds in this chapter and how it feels>"}]}',
].join('\n');
const IDEAS_FORMAT = [
    '',
    'Write every title and text in Korean.',
    `Return JSON only: {"ideas":[{"title":"<short Korean title>","story":"<2-3 Korean sentences describing the storyline>","ending":"<one short Korean sentence: where it ends up>","moods":["<1-3 short Korean mood tags, preferably from: ${PRESETS.mood.join(', ')}>"]}]}`,
].join('\n');
const INNER_FIELDS = '"inner_ko": "<one short Korean line: {{char}}\'s private, unspoken feeling right now, in {{char}}\'s own inner voice>", "warmth": <integer 0-100: how open {{char}} currently is toward {{user}}>';

function judgeFormat(regress, inner) {
    const fields = ['"done": true or false', '"reason_ko": "<one short Korean sentence explaining why>"'];
    if (regress) fields.push('"regress": <true only if {{user}}\'s recent actions clearly pushed things back to before this chapter began, otherwise false>');
    if (inner) fields.push(INNER_FIELDS);
    return `\n\nAnswer with JSON only: {${fields.join(', ')}}`;
}

const PROMPT_INFO = {
    inject: { label: '매 턴 들어가는 방향 문장', vars: 'char, user, story, ending, tone, notes, obstacles, difficulty, chapter, chapter_num, chapter_total, pacing' },
    paceEarly: { label: '페이스: 막 시작됐을 때', vars: 'char, user' },
    paceMid: { label: '페이스: 스며드는 중', vars: 'char, user' },
    paceLate: { label: '페이스: 무르익는 중', vars: 'char, user' },
    paceOver: { label: '페이스: 충분히 익었을 때', vars: 'char, user' },
    paceHold: { label: '페이스: 머물기 중', vars: 'char, user' },
    plan: { label: '과정 만들기', vars: 'char, user, char_description, persona, story, ending, tone, keep, difficulty, obstacles, world_info, length, chapter_count', fixed: true },
    judge: { label: '단계 판정', vars: 'char, user, chapter, next_chapter, recent_messages, difficulty_judge', fixed: true },
    ideas: { label: '아이디어 추천', vars: 'char, user, char_description, persona, world_info, recent_chat, tone, keywords, spice, obstacles, avoid, count', fixed: true },
    diffEasy: { label: '난이도: 순한맛 태도', vars: 'char, user' },
    diffHard: { label: '난이도: 매운맛 태도', vars: 'char, user' },
    diffHell: { label: '난이도: 지옥맛 태도', vars: 'char, user' },
    judgeHard: { label: '난이도: 매운맛 판정 기준', vars: 'char, user' },
    judgeHell: { label: '난이도: 지옥맛 판정 기준', vars: 'char, user' },
    obstacles: { label: '방해꾼 등장', vars: 'char, user, obstacle_detail' },
    inner: { label: '속마음 엿보기', vars: 'char, user, chapter, recent_messages', fixed: true },
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
    const pacing = arc.hold ? fillTemplate(getPrompt('paceHold'), base) : phaseInstruction(effRipeness(arc), base);
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
    });
}

function updateInjection() {
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
async function askLLM(systemPrompt, prompt, maxTokens = 1500) {
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

async function ensureBook(name) {
    if (!name || wiCache.has(name)) return;
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

function wiCount(arc) {
    return Object.values(arc.setup.wi).reduce((n, u) => n + u.length, 0);
}

function parseJson(text) {
    if (!text) throw new Error('빈 응답');
    let t = String(text).replace(/```(?:json)?/gi, '').trim();
    const first = t.search(/[[{]/);
    const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (first < 0 || last < first) throw new Error('JSON을 찾지 못함');
    t = t.slice(first, last + 1);
    return JSON.parse(t);
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

async function generateStages(arc) {
    const c = ctx();
    const moods = moodList(arc);
    const su = arc.setup;
    const charDesc = su.useChar ? clip(c.substituteParams('{{description}}\n{{personality}}'), 2000) : '';
    const persona = su.usePersona ? clip(c.substituteParams('{{persona}}'), 1000) : '';
    await Promise.all(Object.keys(su.wi).map(ensureBook));
    const lore = selectedWiText(arc);
    const count = arc.setup.stageCount === 'auto'
        ? 'Choose between 3 and 8, based on the total length and how much story there is.'
        : `Exactly ${arc.setup.stageCount}.`;

    const prompt = fillTemplate(getPrompt('plan'), {
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
        length: su.length,
        chapter_count: count,
    }) + '\n' + PLAN_FORMAT;

    const raw = await askLLM('You are a story planner for long-form collaborative roleplay. Output only valid JSON.', prompt, 2500);
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
    const data = parseJson(await askLLM('You are a precise translator. Output only valid JSON.', prompt, 600));
    st.title_en = String(data.title_en ?? st.title_ko);
    st.guide_en = String(data.guide_en ?? st.summary_ko);
}

async function suggestIdeas(arc, count, avoid = []) {
    const c = ctx();
    const su = arc.setup;
    const charDesc = su.useChar ? clip(c.substituteParams('{{description}}\n{{personality}}'), 2000) : '';
    const persona = su.usePersona ? clip(c.substituteParams('{{persona}}'), 1000) : '';
    await Promise.all(Object.keys(su.wi).map(ensureBook));
    const lore = selectedWiText(arc);
    const recent = su.ideaUseChat
        ? c.chat.filter(m => !m.is_system).slice(-12).map(m => `${m.name}: ${clip(m.mes, 400)}`).join('\n')
        : '';
    const prompt = fillTemplate(getPrompt('ideas'), {
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
        count,
    }) + '\n' + IDEAS_FORMAT;
    const data = parseJson(await askLLM('You are a creative story consultant for long-form roleplay. Output only valid JSON.', prompt, 1500));
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
    const data = parseJson(await askLLM('You are a careful story analyst. Output only valid JSON.', prompt, 500));
    return {
        done: data.done === true || data.done === 'true',
        regress: canRegress && (data.regress === true || data.regress === 'true'),
        reason: String(data.reason_ko ?? ''),
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
    const inner = readInner(parseJson(await askLLM('You are a perceptive reader of characters. Output only valid JSON.', prompt, 300)));
    if (!inner) throw new Error('속마음이 비어 있음');
    return inner;
}

// ---------- arc control ----------

function pushLog(arc, ok, text) {
    arc.log.unshift({ at: progress(arc), ok, text });
    arc.log = arc.log.slice(0, 30);
}

function advance(arc, manual = false) {
    if (arc.current < arc.stages.length - 1) {
        arc.current++;
        arc.stageStarts[arc.current] = progress(arc);
        arc.stageStarts.length = arc.current + 1;
        arc.lastJudge = progress(arc);
        pushLog(arc, true, `${arc.current + 1}단계 「${arc.stages[arc.current].title_ko}」 시작${manual ? ' (직접 넘김)' : ''}`);
        toastr.success(`${arc.current + 1}단계로 넘어갔어요!`, 'Slow Plot');
    } else {
        arc.status = 'done';
        pushLog(arc, true, '모든 단계 완료! 🎉');
        toastr.success('모든 단계를 완료했어요!', 'Slow Plot');
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
    const s = getSettings();
    const arc = hasChat() ? getArc() : null;
    if (!s.enabled || !arc || arc.status !== 'running' || arc.hold || judging) return;
    const p = progress(arc);
    if (!force) {
        if (p - arc.lastJudge < Number(s.judgeInterval)) return;
        if (ripeness(arc) < judgeGate(arc)) return;
    }
    const chatId = ctx().getCurrentChatId();
    judging = true;
    softRender();
    try {
        arc.lastJudge = p;
        const res = await judgeStage(arc);
        if (ctx().getCurrentChatId() !== chatId) return;
        if (res.inner) { arc.inner = { ...res.inner, at: progress(arc) }; innerShown = false; }
        const tooEarly = res.done && ripeness(arc) < judgeGate(arc);
        if (res.regress && !res.done) {
            pushLog(arc, false, '뒤로 밀려났어요 — ' + res.reason);
            goBack(arc);
            arc.stageStarts[arc.current] = progress(arc);   // the earlier chapter has to be earned again
            toastr.warning(`깡통 마음이 닫혔어요… ${arc.current + 1}단계로 돌아갔어요`, 'Slow Plot');
        } else {
            pushLog(arc, res.done && !tooEarly, (res.done ? (tooEarly ? '이뤄졌지만 아직 이르니 조금 더 머물게요 — ' : '완료! ') : '아직이에요 — ') + res.reason);
            if (res.done && !tooEarly) advance(arc);
        }
        save();
    } catch (err) {
        console.error(LOG, 'judge failed', err);
        pushLog(arc, false, '판정 실패: ' + err.message);
    } finally {
        judging = false;
        updateInjection();
        softRender();
    }
}

// ---------- UI ----------

let busy = '';            // '', 'generate', 'translate'
let editing = -1;
let setupOpen = true;
let wiOpen = false;
let ideaOpen = false;
let advOpen = false;

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
        <button type="button" class="sb-card-head" data-act="toggleSetup" aria-expanded="${setupOpen}">
            <span>줄거리 설정</span>
            <i class="fa-solid ${setupOpen ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>
        </button>
        ${setupOpen ? `
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
            <label class="sb-sub sb-block">꼭 지켜줬으면 하는 것
                <textarea class="sb-input sb-textarea" data-bind="memo" placeholder="예: 연애 없이 끝까지 앙숙 겸 동업자 사이로만">${esc(s.memo)}</textarea>
            </label>
        </div>
        <div class="sb-field">
            <p class="sb-label">깡통 난이도 <span class="sb-sub">(진행 중에도 바꿀 수 있어요)</span></p>
            <div class="sb-chips">${Object.entries(DIFFICULTY).map(([k, d]) => chip(d.label, (s.difficulty || 'normal') === k, 'difficulty', k)).join('')}</div>
            <p class="sb-sub">${esc(diff(arc).hint)}</p>
        </div>
        <div class="sb-field">
            <p class="sb-label">추가 옵션</p>
            <div class="sb-chips">
                ${chip('방해꾼 등장', s.obstacles, 'obstacles', '1')}
                ${chip('속마음 힌트', s.innerHint, 'innerHint', '1')}
            </div>
            ${s.obstacles ? `<label class="sb-sub sb-block">어떤 방해꾼? <span>(안 써도 돼요. 비우면 AI가 어울리는 걸 넣어요)</span>
                <input class="sb-input" data-bind="obstacleText" placeholder="예: 깡통 옛 약혼자가 돌아옴, 옆 동네 대형 베이커리 입점" value="${esc(s.obstacleText)}">
            </label>
            <p class="sb-sub">방해꾼은 과정을 새로 만들 때 줄거리에 들어가요</p>` : ''}
            ${s.innerHint ? '<p class="sb-sub">진행 중에 깡통 속마음 한 줄과 마음 온도를 보여줘요. 판정할 때 같이 갱신돼요</p>' : ''}
        </div>
        <div class="sb-field">
            <p class="sb-label">몇 챗 동안? <span class="sb-sub">(내 메시지 + 봇 답변)</span></p>
            <div class="sb-chips">${lenChips}</div>
            ${s.lengthCustom ? `<input class="sb-input sb-num" type="number" min="20" step="10" data-bind="length" value="${esc(s.length)}">` : ''}
        </div>
        <div class="sb-field">
            <p class="sb-label">몇 단계로?</p>
            <div class="sb-chips">${stageChips}</div>
            ${s.stageCustom ? `<label class="sb-sub sb-block">단계 수 (2~15)<input class="sb-input sb-num" type="number" min="2" max="15" data-bind="stageCount" value="${esc(s.stageCount === 'auto' ? 10 : s.stageCount)}"></label>` : ''}
            ${s.stageCount !== 'auto' ? `<p class="sb-sub">단계당 약 ${Math.round(Number(s.length) / Number(s.stageCount))}챗씩 배정돼요</p>` : ''}
        </div>
        ${renderRefs(arc)}
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
            <div class="sb-idea-title">${esc(idea.title)}</div>
            <div class="sb-idea-story">${esc(idea.story)}</div>
            ${idea.ending ? `<div class="sb-sub"><i class="fa-solid fa-flag-checkered"></i> ${esc(idea.ending)}</div>` : ''}
            ${idea.moods.length ? `<div class="sb-idea-tags">${idea.moods.map(m => `<span>${esc(m)}</span>`).join('')}</div>` : ''}
            <div class="sb-row">
                <button type="button" class="sb-btn sb-small" data-act="ideaReroll" data-value="${i}" ${busy ? 'disabled' : ''}>${busy === `reroll${i}` ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '<i class="fa-solid fa-rotate"></i> 다시'}</button>
                <span class="sb-grow"></span>
                <button type="button" class="sb-btn sb-small sb-primary" data-act="ideaUse" data-value="${i}">이걸로</button>
            </div>
        </div>`).join('');
    return `
    <details class="sb-ideabox" ${ideaOpen ? 'open' : ''}>
        <summary data-act="ideaToggle"><i class="fa-solid fa-dice"></i> 아이디어가 없다면? 추천받기</summary>
        <div class="sb-ideabody">
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
            <button type="button" class="sb-btn sb-idea-go" data-act="ideaGo" ${busy ? 'disabled' : ''}>
                ${loading ? '<i class="fa-solid fa-spinner fa-spin"></i> 고민하는 중…' : `<i class="fa-solid fa-dice"></i> ${arc.ideas?.length ? '다른 아이디어 3개' : '아이디어 3개 받기'}`}
            </button>
            ${cards ? `<div class="sb-ideas">${cards}</div>` : ''}
        </div>
    </details>`;
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
        </div>
        <details class="sb-wi" ${wiOpen ? 'open' : ''}>
            <summary data-act="wiToggle">월드인포 고르기 <span class="sb-sub">(${wiCount(arc)}개 선택됨)</span></summary>
            ${books.length ? `
            <select class="sb-input" data-wibook>
                <option value="">로어북 고르기</option>
                ${books.map(b => `<option value="${esc(b)}" ${b === s.wiBook ? 'selected' : ''}>${linked.includes(b) ? '★ ' : ''}${esc(b)}${s.wi[b]?.length ? ` (${s.wi[b].length})` : ''}</option>`).join('')}
            </select>
            <p class="sb-sub">★ 표시는 이 캐릭터나 채팅에 연결된 로어북이에요</p>
            ${entriesHtml}` : '<p class="sb-sub">로어북이 없어요</p>'}
        </details>
    </div>`;
}

function renderStage(arc, st, i) {
    const running = arc.status !== 'draft';
    const isCur = running && i === arc.current && arc.status !== 'done';
    const isDone = running && (i < arc.current || arc.status === 'done');
    const cls = isCur ? 'cur' : (isDone ? 'done' : '');

    if (editing === i) {
        return `
        <div class="sb-stage edit">
            <div class="sb-edit">
                <label class="sb-sub sb-block">제목<input class="sb-input" data-edit="title_ko" value="${esc(st.title_ko)}"></label>
                <label class="sb-sub sb-block">내용<textarea class="sb-input sb-textarea" data-edit="summary_ko">${esc(st.summary_ko)}</textarea></label>
                <details class="sb-en">
                    <summary>AI가 실제로 읽는 문장 (영어)</summary>
                    <label class="sb-sub sb-block">Title<input class="sb-input" data-edit="title_en" value="${esc(st.title_en)}"></label>
                    <label class="sb-sub sb-block">Guide<textarea class="sb-input sb-textarea" data-edit="guide_en">${esc(st.guide_en)}</textarea></label>
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
    return `
    <div class="sb-stage ${cls}">
        <span class="sb-num-badge">${isDone ? '<i class="fa-solid fa-check"></i>' : i + 1}</span>
        <div class="sb-stage-text">
            <div class="sb-stage-title">${esc(st.title_ko || '(제목 없음)')}</div>
            <div class="sb-stage-sum">${isDone && !isCur ? '완료!' : esc(st.summary_ko)}</div>
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
        const toJudge = Math.max(0, Number(s.judgeInterval) - (p - arc.lastJudge));
        const minLeft = Math.max(0, Math.ceil(stageBudget(arc) * judgeGate(arc) - (p - stageStart(arc))));
        const judgeText = judging ? '지금 판정하는 중…' : (minLeft > 0 ? `${minLeft}챗 뒤부터 판정 시작` : `다음 판정까지 ${toJudge}챗`);
        if (arc.status === 'paused') {
            status = `<b>${arc.current + 1}단계에서 일시정지 중</b><br>AI한테 아무것도 안 보내고, 멈춘 동안의 챗은 세지 않아요`;
        } else if (arc.hold) {
            status = `<b>${arc.current + 1}단계에 머무는 중</b><br>분위기는 계속 깔아두고, 다음 단계로는 넘어가지 않아요`;
        } else {
            status = `${arc.current + 1}단계 ${phaseLabel(r)} · ${judgeText}`;
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
            <button type="button" class="sb-btn" data-act="judgeNow" ${judging || arc.status !== 'running' || arc.hold ? 'disabled' : ''}>지금 판정하기</button>
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
        ${renderInner(arc)}
        <div class="sb-stages">${arc.stages.map((st, i) => renderStage(arc, st, i)).join('')}</div>
        <div class="sb-ctrl two">
            <button type="button" class="sb-btn sb-dashed" data-act="addStage">+ 단계 추가</button>
            <button type="button" class="sb-btn sb-dashed sb-danger-dashed" data-act="clearStages"><i class="fa-solid fa-trash-can"></i> 단계 전부 지우기</button>
        </div>
    </div>
    ${controls}`;
}

let innerShown = false;

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
            ? `<button type="button" class="sb-inner-text ${innerShown ? '' : 'hidden'}" data-act="innerReveal" aria-label="속마음 보기">“${esc(inner.text)}”</button>
               ${innerShown ? '' : '<p class="sb-sub sb-center">스포일러 방지! 눌러서 보기</p>'}
               <p class="sb-sub sb-center">${inner.at}챗째에 엿본 마음</p>`
            : '<p class="sb-sub sb-center">아직 몰라요. 판정할 때 같이 알아내거나, 지금 엿볼 수 있어요</p>'}
        <button type="button" class="sb-btn sb-small" data-act="innerPeek" ${busy ? 'disabled' : ''}>
            ${peeking ? '<i class="fa-solid fa-spinner fa-spin"></i> 엿보는 중…' : '<i class="fa-solid fa-eye"></i> 지금 속마음 엿보기'}
        </button>
    </div>`;
}

function renderLog(arc) {
    if (!arc.log.length) return '';
    return `
    <div class="sb-card">
        <p class="sb-label">판정 기록</p>
        ${arc.log.slice(0, 8).map(l => `<div class="sb-log ${l.ok ? 'ok' : ''}">${l.at}챗 · ${esc(l.text)}</div>`).join('')}
    </div>`;
}

function renderAdvanced() {
    const s = getSettings();
    return `
    <details class="sb-card sb-adv" ${advOpen ? 'open' : ''}>
        <summary class="sb-label" data-act="advToggle">세부 설정</summary>
        <label class="sb-sub sb-block">과정 만들기 · 판정에 쓸 API
            <select class="sb-input sb-wide" data-setting="profileId">
                <option value="">지금 채팅 연결 그대로</option>
                ${listProfiles().map(p => `<option value="${esc(p.id)}" ${s.profileId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
            <span class="sb-block">저렴한 모델의 연결 프로필을 고르면 판정 비용을 아낄 수 있어요. 채팅 연결은 그대로예요.</span>
        </label>
        <label class="sb-sub sb-block">판정 주기 (몇 챗마다)
            <input class="sb-input sb-num" type="number" min="2" max="100" data-setting="judgeInterval" value="${s.judgeInterval}">
        </label>
        <label class="sb-sub sb-block">최소 머무르기 (단계별 배정량의 %)
            <input class="sb-input sb-num" type="number" min="0" max="100" step="5" data-setting="minRatio" value="${Math.round(s.minRatio * 100)}">
        </label>
        <label class="sb-sub sb-block">판정할 때 읽는 최근 메시지 수
            <input class="sb-input sb-num" type="number" min="4" max="60" data-setting="judgeWindow" value="${s.judgeWindow}">
        </label>
        <label class="sb-sub sb-block">끼워 넣는 깊이 (클수록 은근함)
            <input class="sb-input sb-num" type="number" min="0" max="30" data-setting="depth" value="${s.depth}">
        </label>
        <label class="sb-sub sb-block">역할
            <select class="sb-input" data-setting="role">
                ${['system', 'user', 'assistant'].map(r => `<option value="${r}" ${s.role === r ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
        </label>
        ${renderPromptEditor()}
        <button type="button" class="sb-btn sb-danger" data-act="reset">이 채팅의 과정 지우기</button>
    </details>`;
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

function render() {
    const body = document.getElementById('sb_body');
    if (!body) return;
    const s = getSettings();
    const toggle = document.getElementById('sb_enabled');
    if (toggle) toggle.checked = s.enabled;

    if (!hasChat()) {
        body.innerHTML = '<div class="sb-card sb-center sb-sub">채팅을 열면 여기서 줄거리 과정을 만들 수 있어요</div>';
        return;
    }
    const arc = getArc();
    body.innerHTML = renderSetup(arc) + renderProgress(arc) + renderLog(arc) + renderAdvanced();
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
    if (act === 'toggleSetup') { setupOpen = !setupOpen; render(); return; }
    if (act === 'wiToggle') { wiOpen = !wiOpen; return; }
    if (act === 'ideaToggle') { ideaOpen = !ideaOpen; return; }
    if (act === 'advToggle') { advOpen = !advOpen; return; }
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
        case 'ideaSpice': su.ideaSpice = val; break;
        case 'difficulty': su.difficulty = val; break;
        case 'obstacles': su.obstacles = !su.obstacles; break;
        case 'innerHint': su.innerHint = !su.innerHint; break;
        case 'innerReveal': innerShown = !innerShown; break;
        case 'innerPeek': {
            busy = 'inner'; render();
            try {
                arc.inner = { ...(await peekInner(arc)), at: progress(arc) };
                innerShown = false;
            } catch (err) {
                console.error(LOG, err);
                toastr.error('엿보기 실패: ' + err.message, 'Slow Plot');
            } finally { busy = ''; }
            break;
        }
        case 'ideaUseChat': su.ideaUseChat = !su.ideaUseChat; break;
        case 'ideaGo': {
            busy = 'ideas'; render();
            try {
                arc.ideas = await suggestIdeas(arc, 3, arc.ideas || []);
            } catch (err) {
                console.error(LOG, err);
                toastr.error('추천 실패: ' + err.message + ' (API 연결을 확인해 주세요)', 'Slow Plot');
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
                setupOpen = false;
                toastr.success('과정을 만들었어요! 마음에 안 드는 단계는 고쳐보세요', 'Slow Plot');
            } catch (err) {
                console.error(LOG, err);
                toastr.error('과정 만들기 실패: ' + err.message + ' (API 연결을 확인해 주세요)', 'Slow Plot');
            } finally { busy = ''; }
            break;
        }
        case 'start':
            if (editing >= 0) { toastr.info('수정 중인 단계를 먼저 저장해 주세요', 'Slow Plot'); return; }
            Object.assign(arc, { status: 'running', current: 0, base: messageCount(), stageStarts: [0], lastJudge: 0, hold: false, frozenAt: null, log: [] });
            pushLog(arc, true, `1단계 「${arc.stages[0].title_ko}」 시작`);
            break;
        case 'pause': pauseArc(arc); break;
        case 'resume': resumeArc(arc); break;
        case 'next': advance(arc, true); break;
        case 'prev': goBack(arc); break;
        case 'hold': toggleHold(arc); break;
        case 'judgeNow': save(); maybeJudge(true); return;
        case 'preview': {
            const text = arc.status === 'running' ? buildInjection(arc) : '(지금은 아무것도 보내지 않아요. 진행 중일 때만 보내요)';
            await c.Popup.show.text('AI한테 가는 문장', `<pre class="sb-pre">${esc(text)}</pre>`);
            return;
        }
        case 'clearStages': {
            const ok = await c.Popup.show.confirm('단계 전부 지우기', '만들어진 단계와 진행 상황, 판정 기록을 한 번에 지울까요? 위에 써둔 줄거리 설정은 그대로 남아요.');
            if (!ok) return;
            Object.assign(arc, { stages: [], arcEn: null, status: 'setup', current: 0, base: 0, stageStarts: [], lastJudge: 0, hold: false, frozenAt: null, log: [] });
            editing = -1; setupOpen = true;
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
            editing = -1; setupOpen = true;
            break;
        }

        case 'edit': editing = Number(val); break;
        case 'cancelEdit': editing = -1; break;
        case 'addStage':
            arc.stages.push({ title_ko: '', summary_ko: '', title_en: '', guide_en: '' });
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
            const to = editing + Number(val);
            if (to < 0 || to >= arc.stages.length) return;
            [arc.stages[editing], arc.stages[to]] = [arc.stages[to], arc.stages[editing]];
            editing = to;
            break;
        }
        case 'saveEdit': {
            const box = btn.closest('.sb-edit');
            const get = k => box.querySelector(`[data-edit="${k}"]`).value.trim();
            const st = arc.stages[editing];
            const next = { title_ko: get('title_ko'), summary_ko: get('summary_ko'), title_en: get('title_en'), guide_en: get('guide_en') };
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

function onInput(e) {
    const el = e.target;
    const arc = hasChat() ? getArc() : null;
    if (el.dataset.bind && arc) {
        const k = el.dataset.bind;
        if (k === 'length') arc.setup.length = Math.max(20, Number(el.value) || 400);
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
        const counter = document.querySelector('#sb_root .sb-wi summary .sb-sub');
        if (counter) counter.textContent = `(${wiCount(arc)}개 선택됨)`;
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
                    <div class="sb-top">
                        <div class="sb-brand"><span class="sb-logo">${SNAIL_SVG}</span>Slow Plot</div>
                        <label class="sb-switch"><span>ON</span>
                            <input id="sb_enabled" type="checkbox">
                            <span class="sb-track"><span class="sb-knob"></span></span>
                        </label>
                    </div>
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
    document.getElementById('sb_enabled').addEventListener('change', e => {
        getSettings().enabled = e.target.checked;
        ctx().saveSettingsDebounced();
        updateInjection();
    });
}

// Pink-shelled snail: the extension's mark ("slow").
const SNAIL_SVG = `<svg class="sb-snail" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M47 34 L44 18" stroke="#9B85E8" stroke-width="3.5" stroke-linecap="round"/><path d="M54 35 L57 20" stroke="#9B85E8" stroke-width="3.5" stroke-linecap="round"/><circle cx="44" cy="17" r="3.6" fill="#9B85E8"/><circle cx="57" cy="19" r="3.6" fill="#9B85E8"/><path d="M8 52 Q8 46 16 46 L46 46 Q50 34 56 38 Q62 42 60 50 Q59 55 52 55 L12 55 Q8 55 8 52Z" fill="#B9A8EE"/><circle cx="27" cy="32" r="17" fill="#FF8FB1"/><path d="M27 32 m0 -2 a2 2 0 1 1 -2 2 a5 5 0 0 1 5 -5 a8 8 0 0 1 8 8 a11 11 0 0 1 -11 11 a13 13 0 0 1 -13 -13" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="53" cy="44" r="1.8" fill="#4E36B0"/></svg>`;

// ---------- events ----------

// Re-render from background events without wiping what the user is typing.
function softRender() {
    if (editing >= 0) return;
    if (document.activeElement?.closest?.('#sb_root .sb-input')) return;
    render();
}

function refresh() {
    editing = -1;
    const arc = hasChat() ? getArc() : null;
    setupOpen = !arc || !arc.stages.length;
    updateInjection();
    render();
}

(function init() {
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.APP_READY, () => {
        getSettings();
        buildPanel();
        refresh();
    });
    eventSource.on(event_types.CHAT_CHANGED, refresh);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => updateInjection());
    eventSource.on(event_types.MESSAGE_SENT, () => { updateInjection(); softRender(); });
    eventSource.on(event_types.MESSAGE_DELETED, () => { updateInjection(); softRender(); });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        updateInjection();
        softRender();
        maybeJudge();
    });
})();
