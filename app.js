(() => {
  "use strict";

  const STORAGE = { game: "musicQuiz.game.v2", quiz: "musicQuiz.customQuiz.v2" };
  const $ = (id) => document.getElementById(id);
  const listen = (id, eventName, handler) => {
    const element = $(id);
    if (element) element.addEventListener(eventName, handler);
    else console.warn(`Music Quiz: #${id} is unavailable. Refresh to load the latest page assets.`);
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const makeDefaultTeam = (index) => ({ name: `Team ${index + 1}`, score: 0 });
  const defaultTeams = [makeDefaultTeam(0), makeDefaultTeam(1)];
  let quiz = normalizeQuiz(clone(QUIZ));
  let game = { teams: clone(defaultTeams), completed: [], signature: "" };
  let quizLibrary = [];
  let activeIndex = null;
  let answerRevealed = false;
  let player = null;
  let editorPlayer = null;
  let apiReady = false;
  let monitor = null;
  let editorTick = null;
  let editorDraft = null;
  let editorIndex = 0;
  let metadataTimer = null;
  let metadataTarget = null;
  let segmentStart = null;
  let segmentEnd = null;
  let pendingPresentation = null;
  let pendingAwards = [];

  window.onYouTubeIframeAPIReady = () => {
    apiReady = true;
    if (activeIndex !== null) ensureGamePlayer();
    if (metadataTarget && editorDraft) loadEditorVideo(true);
  };
  if (window.YT && window.YT.Player) apiReady = true;

  function parseTimestamp(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : NaN;
    const input = String(value ?? "").trim();
    if (!input) return 0;
    if (/^\d+(\.\d+)?$/.test(input)) return Number(input);
    const parts = input.split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return NaN;
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + Number(part);
    return seconds;
  }

  function formatTimestamp(value) {
    const total = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(total / 60);
    const seconds = total - minutes * 60;
    const formatted = seconds.toFixed(seconds % 1 ? 1 : 0).padStart(seconds < 10 ? 2 : 1, "0");
    return `${minutes}:${formatted}`;
  }

  function extractYouTubeId(input) {
    const raw = String(input || "").trim();
    if (/^[\w-]{11}$/.test(raw)) return raw;
    try {
      const url = new URL(raw);
      const host = url.hostname.replace(/^www\./, "");
      let id = "";
      if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] || "";
      if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
        if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
        else if (/^\/(shorts|embed)\//.test(url.pathname)) id = url.pathname.split("/")[2] || "";
      }
      return /^[\w-]{11}$/.test(id) ? id : null;
    } catch { return null; }
  }

  function normalizeQuiz(data) {
    const normalized = clone(data);
    normalized.title = String(normalized.title || "Music Quiz").trim();
    normalized.questions = normalized.questions.map((q) => ({
      category: String(q.category || "Uncategorized").trim(),
      points: String(q.points ?? "").trim(), youtube: String(q.youtube || "").trim(),
      start: q.start ?? 0, stop: q.stop ?? 10, revealStart: q.revealStart ?? q.stop ?? 10,
      question: String(q.question || "Listen to the music clip."),
      answer: String(q.answer || ""), song: String(q.song || ""), artist: String(q.artist || ""),
      answerPlaybackDuration: Number(q.answerPlaybackDuration) || 8,
      hiddenVideo: typeof q.hiddenVideo === "boolean" ? q.hiddenVideo : String(q.category) === "Who's Singing?"
    }));
    normalized.categories = [...new Set([
      ...(Array.isArray(normalized.categories) ? normalized.categories.map(String) : []),
      ...normalized.questions.map((q) => q.category)
    ])].filter(Boolean);
    return normalized;
  }

  function validateQuiz(data) {
    if (!data || typeof data !== "object") return "The file does not contain a quiz object.";
    if (typeof data.title !== "string" || !data.title.trim()) return "The quiz needs a title.";
    if (!Array.isArray(data.questions) || !data.questions.length) return "The quiz needs at least one question.";
    const categories = Array.isArray(data.categories) ? data.categories.map(String) : [...new Set(data.questions.map((q) => String(q?.category || "")))];
    if (categories.length !== 5 || new Set(categories).size !== 5) return "The quiz must contain exactly 5 unique categories.";
    if (data.questions.length !== 20) return "The quiz must contain exactly 4 questions in each of its 5 categories.";
    if (categories.some((category) => data.questions.filter((q) => String(q?.category) === category).length !== 4)) return "Every category must contain exactly 4 questions.";
    for (let i = 0; i < data.questions.length; i += 1) {
      const q = data.questions[i];
      if (!q || typeof q !== "object" || !String(q.category || "").trim()) return `Question ${i + 1} needs a category.`;
      if ((typeof q.points !== "string" && typeof q.points !== "number") || !String(q.points).trim()) return `Question ${i + 1} needs a quiz title.`;
      const start = parseTimestamp(q.start), stop = parseTimestamp(q.stop);
      if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return `Question ${i + 1} needs a valid stop time after its start time.`;
      if (!Number.isFinite(parseTimestamp(q.revealStart ?? q.stop))) return `Question ${i + 1} needs a valid reveal start time.`;
      if (q.youtube && !extractYouTubeId(q.youtube)) return `Question ${i + 1} has an invalid YouTube URL.`;
    }
    return null;
  }

  function loadCustomQuiz() {
    try { const value = JSON.parse(localStorage.getItem(STORAGE.quiz)); return validateQuiz(value) ? null : normalizeQuiz(value); }
    catch { return null; }
  }

  async function fetchQuizJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
    const data = await response.json(); const error = validateQuiz(data);
    if (error) throw new Error(error); return normalizeQuiz(data);
  }

  function libraryQuizUrl(file) {
    const libraryRoot = new URL("quizzes/", document.baseURI); const url = new URL(String(file || ""), libraryRoot);
    if (url.origin !== libraryRoot.origin || !url.pathname.startsWith(libraryRoot.pathname)) throw new Error("The quiz library contains an invalid file path.");
    return url.href;
  }

  async function loadQuizLibrary() {
    try {
      const response = await fetch("quizzes/manifest.json", { cache: "no-cache" });
      if (!response.ok) throw new Error(`Manifest returned ${response.status}.`);
      const manifest = await response.json(); const entries = Array.isArray(manifest) ? manifest : manifest.quizzes;
      quizLibrary = Array.isArray(entries) ? entries.filter((entry) => entry && entry.name && entry.file) : [];
    } catch (error) { quizLibrary = []; console.warn("Music Quiz: quiz library could not be loaded.", error); }
    populateQuizLibrary();
  }

  function populateQuizLibrary() {
    const select = $("quizLibrarySelect"); if (!select) return;
    select.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: quizLibrary.length ? "Choose a quiz…" : "No saved quizzes found" }));
    quizLibrary.forEach((entry, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = entry.name; select.append(option); });
  }

  async function loadSelectedLibraryQuiz() {
    const selectedValue = $("quizLibrarySelect").value; const entry = selectedValue === "" ? null : quizLibrary[Number(selectedValue)];
    if (!entry) { $("editorStatus").textContent = "Choose a saved quiz first."; return; }
    try {
      const loadedQuiz = await fetchQuizJson(libraryQuizUrl(entry.file)); destroyEditorPlayer(); editorDraft = loadedQuiz; editorIndex = 0;
      $("editorTitle").value = editorDraft.title; renderEditorList(); loadEditorQuestion(); toast(`${entry.name} loaded. Press Save quiz to apply it.`);
    } catch (error) { $("editorStatus").classList.add("error"); $("editorStatus").textContent = `Could not load saved quiz: ${error.message}`; }
  }

  function quizSignature() {
    return JSON.stringify(quiz.questions.map((q) => [q.category, q.points, q.youtube, q.start, q.stop, q.revealStart, q.hiddenVideo]));
  }

  function loadGame() {
    const fallback = { teams: clone(defaultTeams), completed: [], signature: "" };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE.game));
      if (!saved || !Array.isArray(saved.teams)) return fallback;
      saved.teams = saved.teams.slice(0, 8).map((team, i) => ({ name: String(team.name || `Team ${i + 1}`), score: Number(team.score) || 0 }));
      if (!saved.teams.length) saved.teams = clone(defaultTeams);
      saved.completed = saved.signature === quizSignature() && Array.isArray(saved.completed) ? saved.completed : [];
      saved.signature = quizSignature();
      return saved;
    } catch { return fallback; }
  }

  function saveGame() {
    game.signature = quizSignature();
    localStorage.setItem(STORAGE.game, JSON.stringify(game));
  }

  function render() {
    document.title = quiz.title;
    $("quizTitle").textContent = quiz.title;
    $("quizSubtitle").textContent = `${quiz.categories.length} categories · ${quiz.questions.length} questions`;
    renderTeams(); renderBoard();
  }

  function renderTeams() {
    $("teams").replaceChildren(...game.teams.map((team, index) => {
      const card = document.createElement("div"); card.className = "team-card";
      const input = document.createElement("input"); input.value = team.name; input.setAttribute("aria-label", `Team ${index + 1} name`);
      input.addEventListener("input", () => { game.teams[index].name = input.value; saveGame(); renderScoreButtons(); });
      const score = document.createElement("strong"); score.textContent = team.score;
      card.append(input, score); return card;
    }));
  }

  function renderBoard() {
    const board = $("board"); board.replaceChildren();
    board.style.setProperty("--columns", quiz.categories.length);
    quiz.categories.forEach((category) => { const header = document.createElement("div"); header.className = "category-header"; header.textContent = category; board.append(header); });
    for (let questionNumber = 0; questionNumber < 4; questionNumber += 1) quiz.categories.forEach((category) => {
      const categoryIndexes = quiz.questions.map((q, index) => q.category === category ? index : -1).filter((index) => index >= 0);
      const index = categoryIndexes[questionNumber];
      if (!Number.isInteger(index)) { const gap = document.createElement("div"); gap.className = "tile gap"; board.append(gap); return; }
      const quizTitle = quiz.questions[index].points;
      const button = document.createElement("button"); const completed = game.completed.includes(index);
      button.type = "button"; button.className = "tile"; button.disabled = completed;
      button.textContent = completed ? "✓" : quizTitle; button.setAttribute("aria-label", `${category}, question ${questionNumber + 1}: ${quizTitle}${completed ? ", completed" : ""}`);
      button.addEventListener("click", () => openQuestion(index)); board.append(button);
    });
  }

  function showView(name) {
    $("boardView").hidden = name !== "board"; $("questionView").hidden = name !== "question"; $("editorView").hidden = name !== "editor";
    document.body.classList.toggle("editor-open", name === "editor");
    document.body.classList.toggle("question-open", name === "question"); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function questionTimes(q) { return { start: parseTimestamp(q.start), stop: parseTimestamp(q.stop), revealStart: parseTimestamp(q.revealStart ?? q.stop) }; }

  function openQuestion(index) {
    stopPlayback(); activeIndex = index; answerRevealed = false; pendingPresentation = null; pendingAwards = game.teams.map(() => 0);
    const q = quiz.questions[index]; const { start, stop } = questionTimes(q); updateClipProgress(start, start, stop);
    const questionNumber = quiz.questions.filter((item, itemIndex) => item.category === q.category && itemIndex <= index).length;
    $("questionCategory").textContent = q.category; $("questionPoints").textContent = `Question ${questionNumber}`;
    $("questionPrompt").textContent = q.question || "Listen to the music clip.";
    $("questionInstruction").textContent = q.category === "First Words" ? "Listen to the intro, then guess the first words sung." : q.category === "Finish the Lyrics" ? "Continue the lyric after the clip stops." : "Listen carefully and give your answer.";
    $("clipRange").textContent = Number.isFinite(start) && Number.isFinite(stop) ? `Clip ${formatTimestamp(start)} → ${formatTimestamp(stop)} · Reveal from ${formatTimestamp(questionTimes(q).revealStart)}` : "Timestamps need attention";
    $("answerLabel").textContent = q.category === "First Words" ? "First words" : "Answer";
    $("answerText").textContent = q.answer || "No answer configured";
    $("songInfo").textContent = [q.artist, q.song].filter(Boolean).join(" — ") || "No song details configured";
    $("answerCard").hidden = true; $("scoringPanel").hidden = true; $("revealButton").hidden = false;
    $("playerCard").classList.toggle("video-concealed", q.hiddenVideo === true);
    $("playerCard").classList.add("awaiting-play", "question-copy-pending");
    setStatus(questionWarning(q)); renderScoreButtons(); showView("question"); ensureGamePlayer();
  }

  function questionWarning(q) {
    if (!q.youtube) return "No YouTube URL configured. Open the quiz editor to add one.";
    if (!extractYouTubeId(q.youtube)) return "This question has an invalid YouTube URL.";
    const { start, stop } = questionTimes(q);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return "The stop time must be later than the start time.";
    if (!Number.isFinite(questionTimes(q).revealStart)) return "The reveal start time is invalid.";
    return "Ready.";
  }

  function setStatus(message, error = false) { $("playerStatus").textContent = message; $("playerStatus").classList.toggle("error", error); }

  function ensureGamePlayer() {
    if (!apiReady || activeIndex === null) { if (!apiReady) setStatus("Loading the YouTube player…"); return; }
    const id = extractYouTubeId(quiz.questions[activeIndex].youtube); if (!id) return;
    if (!player) {
      player = new YT.Player("youtubePlayer", { height: "360", width: "640", videoId: id, playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0 }, events: {
        onReady: () => { const iframe = player.getIframe(); iframe.setAttribute("tabindex", "-1"); setStatus("Ready."); }, onError: handlePlayerError,
        onStateChange: (event) => {
          setPlayButton(event.data === YT.PlayerState.PLAYING);
          if (event.data === YT.PlayerState.PLAYING) {
            presentPlaybackContent();
            if (Number.isFinite(segmentEnd)) startMonitor(segmentEnd);
          }
          if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) clearMonitor();
        }
      }});
    } else { player.cueVideoById(id); setStatus("Ready."); }
  }

  function handlePlayerError(event) {
    const messages = { 2: "The YouTube URL is invalid.", 5: "This video cannot play in the HTML5 player.", 100: "This video is private, removed, or unavailable.", 101: "The owner does not allow this video to be embedded.", 150: "The owner does not allow this video to be embedded." };
    if (pendingPresentation === "answer") { answerRevealed = false; $("revealButton").hidden = false; }
    pendingPresentation = null;
    setStatus(messages[event.data] || "YouTube could not play this video.", true); clearMonitor();
  }

  function startMonitor(stopAt) {
    clearMonitor();
    const update = () => {
      if (!player || typeof player.getCurrentTime !== "function") return;
      const current = player.getCurrentTime(); updateClipProgress(current, segmentStart, stopAt);
      if (current >= stopAt) { updateClipProgress(stopAt, segmentStart, stopAt); player.pauseVideo(); clearMonitor(); setStatus("Clip stopped at the configured cutoff."); }
    };
    update(); monitor = window.setInterval(update, 75);
  }

  function updateClipProgress(current, start, end) {
    const safeStart = Number(start) || 0, safeEnd = Number(end) || safeStart, duration = Math.max(0, safeEnd - safeStart);
    const elapsed = Math.min(duration, Math.max(0, (Number(current) || 0) - safeStart)); const percent = duration ? elapsed / duration * 100 : 0;
    $("progressFill").style.width = `${percent}%`; $("progressTime").textContent = formatTimestamp(Math.max(0, duration - elapsed));
  }

  function clearMonitor() { if (monitor !== null) window.clearInterval(monitor); monitor = null; }
  function setPlayButton(isPlaying) {
    $("playButton").textContent = isPlaying ? "Ⅱ" : "▶";
    $("playButton").setAttribute("aria-label", isPlaying ? "Pause clip" : "Play clip");
  }
  function presentPlaybackContent() {
    if (pendingPresentation === "clip") {
      $("playerCard").classList.remove("awaiting-play", "question-copy-pending");
    } else if (pendingPresentation === "answer") {
      $("answerCard").hidden = false; $("scoringPanel").hidden = false;
      $("playerCard").classList.remove("video-concealed", "awaiting-play");
      $("answerCard").classList.add("reveal");
      window.setTimeout(() => $("answerCard").classList.remove("reveal"), 450);
      $("answerCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    pendingPresentation = null;
  }
  function stopPlayback() { clearMonitor(); segmentStart = null; segmentEnd = null; if (player && typeof player.pauseVideo === "function") player.pauseVideo(); setPlayButton(false); }

  function playSegment(mode = "clip") {
    if (activeIndex === null) return false;
    const q = quiz.questions[activeIndex], id = extractYouTubeId(q.youtube), times = questionTimes(q);
    if (!id || !Number.isFinite(times.start) || !Number.isFinite(times.stop) || times.stop <= times.start) { setStatus(questionWarning(q), true); return false; }
    if (!apiReady) { setStatus("The YouTube API is still loading. Check your connection and try again.", true); return false; }
    if (!player || typeof player.loadVideoById !== "function") { ensureGamePlayer(); setStatus("Preparing the player…"); return false; }
    const start = mode === "answer" ? times.revealStart : times.start;
    const end = mode === "answer" ? times.revealStart + (Number(q.answerPlaybackDuration) || 8) : times.stop;
    pendingPresentation = mode;
    segmentStart = start; segmentEnd = end; updateClipProgress(start, start, end); clearMonitor(); player.loadVideoById({ videoId: id, startSeconds: start }); player.playVideo();
    setStatus(mode === "answer" ? `Playing the answer from ${formatTimestamp(start)} for about ${q.answerPlaybackDuration || 8} seconds.` : `Playing ${formatTimestamp(start)} → ${formatTimestamp(end)}.`);
    return true;
  }

  function togglePlay() {
    if (!player || !window.YT) return playSegment();
    if (player.getPlayerState() === YT.PlayerState.PLAYING) { stopPlayback(); setStatus("Paused."); return; }
    const q = activeIndex === null ? null : quiz.questions[activeIndex];
    const times = q ? questionTimes(q) : null;
    const current = Number(player.getCurrentTime());
    if (times && current >= times.start && current < times.stop) {
      pendingPresentation = $("playerCard").classList.contains("question-copy-pending") ? "clip" : null;
      segmentStart = times.start; segmentEnd = times.stop; player.playVideo(); setStatus(`Resumed. Clip stops at ${formatTimestamp(times.stop)}.`);
    } else playSegment();
  }

  function revealAnswer() {
    if (activeIndex === null || answerRevealed) return;
    answerRevealed = true;
    if (!playSegment("answer")) { answerRevealed = false; return; }
    $("revealButton").hidden = true;
  }

  function renderScoreButtons() {
    if (activeIndex === null) return; const holder = $("scoreButtons"); holder.replaceChildren();
    while (pendingAwards.length < game.teams.length) pendingAwards.push(0);
    game.teams.forEach((team, index) => {
      const row = document.createElement("div"); row.className = "team-award-row";
      const name = document.createElement("strong"); name.textContent = team.name || `Team ${index + 1}`; row.append(name);
      const choices = document.createElement("div"); choices.className = "point-choices";
      for (let points = 0; points <= 5; points += 1) {
        const button = document.createElement("button"); button.type = "button"; button.className = "point-choice";
        button.classList.toggle("selected", pendingAwards[index] === points); button.textContent = points; button.setAttribute("aria-label", `Give ${name.textContent} ${points} points`);
        button.addEventListener("click", () => { pendingAwards[index] = points; renderScoreButtons(); }); choices.append(button);
      }
      row.append(choices); holder.append(row);
    });
  }

  function finishQuestion(useAwards = true) {
    if (activeIndex === null) return;
    if (useAwards) game.teams.forEach((team, index) => { team.score += Number(pendingAwards[index]) || 0; });
    if (!game.completed.includes(activeIndex)) game.completed.push(activeIndex); saveGame(); closeQuestion(); render();
  }

  function closeQuestion() { stopPlayback(); activeIndex = null; answerRevealed = false; pendingPresentation = null; showView("board"); }

  function resetGame() {
    if (!window.confirm("Reset team names, scores, and every completed question?")) return;
    stopPlayback(); destroyEditorPlayer(); editorDraft = null; localStorage.removeItem(STORAGE.game); game = { teams: clone(defaultTeams), completed: [], signature: quizSignature() }; activeIndex = null; render(); showView("board"); toast("Game reset.");
  }

  function setTeamCount(value) {
    const count = Math.min(8, Math.max(1, Math.round(Number(value) || 2)));
    while (game.teams.length < count) game.teams.push(makeDefaultTeam(game.teams.length));
    if (game.teams.length > count) game.teams.length = count;
    $("teamCount").value = count; saveGame(); renderTeams(); renderScoreButtons(); toast(`${count} ${count === 1 ? "team" : "teams"} ready.`);
  }

  function toast(message) { const node = $("toast"); node.textContent = message; node.classList.add("show"); window.setTimeout(() => node.classList.remove("show"), 2600); }

  function openEditor() {
    stopPlayback(); editorDraft = clone(quiz); editorIndex = 0; $("editorTitle").value = editorDraft.title;
    if ($("teamCount")) $("teamCount").value = game.teams.length;
    populateQuizLibrary(); renderEditorList(); loadEditorQuestion(); showView("editor");
  }

  const editorFields = { points: "editPoints", youtube: "editYoutube", start: "editStart", stop: "editStop", revealStart: "editRevealStart", question: "editQuestion", answer: "editAnswer", song: "editSong", artist: "editArtist", answerPlaybackDuration: "editAnswerDuration" };
  function syncEditorQuestion() {
    if (!editorDraft?.questions[editorIndex]) return;
    const q = editorDraft.questions[editorIndex];
    Object.entries(editorFields).forEach(([key, id]) => { q[key] = key === "answerPlaybackDuration" ? Number($(id).value) : $(id).value; });
    q.hiddenVideo = $("editHiddenVideo").checked;
    editorDraft.title = $("editorTitle").value;
  }

  function loadEditorQuestion() {
    if (metadataTimer !== null) window.clearTimeout(metadataTimer); metadataTimer = null; metadataTarget = null;
    const q = editorDraft.questions[editorIndex]; if (!q) return;
    Object.entries(editorFields).forEach(([key, id]) => { $(id).value = q[key] ?? ""; });
    $("editHiddenVideo").checked = q.hiddenVideo === true;
    $("editorStatus").textContent = ""; $("editorStatus").classList.remove("error"); updateTimestampReadout(0);
  }

  function renderEditorList() {
    const list = $("editorQuestionList"); list.replaceChildren(...editorDraft.categories.map((category, categoryIndex) => {
      const folder = document.createElement("details"); folder.className = "editor-category";
      const indexes = editorDraft.questions.map((q, index) => q.category === category ? index : -1).filter((index) => index >= 0);
      folder.open = indexes.includes(editorIndex);
      const summary = document.createElement("summary");
      const categoryName = document.createElement("input"); categoryName.className = "category-name-input"; categoryName.value = category; categoryName.setAttribute("aria-label", `Category ${categoryIndex + 1} title`);
      categoryName.addEventListener("click", (event) => event.stopPropagation()); categoryName.addEventListener("keydown", (event) => event.stopPropagation());
      let currentCategory = category;
      categoryName.addEventListener("input", () => {
        const nextCategory = categoryName.value;
        editorDraft.questions.forEach((question) => { if (question.category === currentCategory) question.category = nextCategory; });
        editorDraft.categories[categoryIndex] = nextCategory; currentCategory = nextCategory;
      });
      const count = document.createElement("small"); count.textContent = "4 questions"; summary.append(categoryName, count); folder.append(summary);
      const questions = document.createElement("div"); questions.className = "editor-category-questions";
      indexes.forEach((index, questionIndex) => {
        const q = editorDraft.questions[index]; const button = document.createElement("button"); button.type = "button"; button.className = "editor-question";
        button.classList.toggle("selected", index === editorIndex); button.innerHTML = `<span>Question ${questionIndex + 1}</span><small>${escapeHtml(q.points)}</small>`;
        button.addEventListener("click", () => { syncEditorQuestion(); editorIndex = index; renderEditorList(); loadEditorQuestion(); }); questions.append(button);
      });
      folder.append(questions); return folder;
    }));
  }

  function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value); return node.innerHTML; }

  function saveEditor(event) {
    event.preventDefault(); syncEditorQuestion(); editorDraft.categories = [...new Set(editorDraft.questions.map((q) => String(q.category).trim()))].filter(Boolean);
    const error = validateQuiz(editorDraft); if (error) { $("editorStatus").textContent = error; $("editorStatus").classList.add("error"); return; }
    quiz = normalizeQuiz(editorDraft); localStorage.setItem(STORAGE.quiz, JSON.stringify(quiz));
    game.completed = []; game.signature = quizSignature(); saveGame(); destroyEditorPlayer(); render(); showView("board"); toast("Quiz saved. Completed questions were cleared.");
  }

  function closeEditor() { destroyEditorPlayer(); editorDraft = null; showView("board"); }

  function cleanMetadataText(value) {
    return String(value || "").replace(/\s*[\[(](?:official\s*)?(?:music\s*)?(?:video|audio|lyric(?:s| video)?|visuali[sz]er|hd|4k)[^\])]*[\])]/gi, "").replace(/\s+/g, " ").trim();
  }

  function splitVideoMetadata(title, author) {
    const cleanTitle = cleanMetadataText(title);
    const cleanAuthor = String(author || "").replace(/\s+-\s+Topic$/i, "").replace(/VEVO$/i, "").trim();
    const parts = cleanTitle.split(/\s+(?:-|–|—)\s+/);
    if (parts.length >= 2) return { artist: parts.shift().trim(), song: parts.join(" - ").trim() };
    return { artist: cleanAuthor, song: cleanTitle };
  }

  function readEditorMetadata(attempt = 0) {
    if (!metadataTarget) return;
    if (!editorPlayer?.getVideoData) {
      metadataTarget = null; $("editorStatus").textContent = "YouTube metadata is unavailable for this video. Enter the song and artist manually."; return;
    }
    let data; try { data = editorPlayer.getVideoData(); } catch { data = null; }
    if (!data?.title || (data.video_id && data.video_id !== metadataTarget.id)) {
      if (attempt < 10) window.setTimeout(() => readEditorMetadata(attempt + 1), 250);
      else { metadataTarget = null; $("editorStatus").textContent = "Could not read the song details automatically. Enter or review them manually."; }
      return;
    }
    const target = metadataTarget; metadataTarget = null;
    if (!editorDraft || target.index !== editorIndex || extractYouTubeId($("editYoutube").value) !== target.id) return;
    const details = splitVideoMetadata(data.title, data.author);
    if (details.song) $("editSong").value = details.song;
    if (details.artist) $("editArtist").value = details.artist;
    editorDraft.questions[editorIndex].song = $("editSong").value; editorDraft.questions[editorIndex].artist = $("editArtist").value;
    $("editorStatus").classList.remove("error");
    $("editorStatus").textContent = details.artist ? "Song and artist filled from YouTube metadata. Review them before saving." : "Song title filled from YouTube metadata. Add or review the artist before saving.";
  }

  function scheduleMetadataLookup() {
    if (metadataTimer !== null) window.clearTimeout(metadataTimer);
    metadataTimer = window.setTimeout(() => {
      metadataTimer = null; if (!editorDraft) return; syncEditorQuestion();
      const id = extractYouTubeId($("editYoutube").value); if (!id) return;
      metadataTarget = { id, index: editorIndex }; loadEditorVideo(true);
    }, 450);
  }

  function loadEditorVideo(automatic = false) {
    syncEditorQuestion(); const id = extractYouTubeId(editorDraft.questions[editorIndex].youtube);
    if (!id) { if (!automatic) { $("editorStatus").textContent = "Enter a valid YouTube URL first."; $("editorStatus").classList.add("error"); } return; }
    if (!apiReady) { $("editorStatus").textContent = "The YouTube API is still loading. Check your connection and try again."; return; }
    $("editorStatus").classList.remove("error");
    if (!editorPlayer) editorPlayer = new YT.Player("editorYoutubePlayer", { height: "315", width: "560", videoId: id, playerVars: { playsinline: 1, rel: 0 }, events: {
      onReady: () => readEditorMetadata(),
      onStateChange: (event) => { if ([YT.PlayerState.CUED, YT.PlayerState.PLAYING, YT.PlayerState.PAUSED].includes(event.data)) readEditorMetadata(); },
      onError: (event) => { metadataTarget = null; $("editorStatus").textContent = `YouTube player error ${event.data}. The video may be unavailable or blocked from embedding.`; }
    } });
    else editorPlayer.cueVideoById(id);
    $("editorStatus").textContent = automatic ? "Reading song details from YouTube…" : "Video loaded. Use the YouTube controls to find your timestamps.";
    if (metadataTarget) window.setTimeout(() => readEditorMetadata(), 300);
    if (editorTick !== null) window.clearInterval(editorTick);
    editorTick = window.setInterval(() => { if (editorPlayer?.getCurrentTime) updateTimestampReadout(editorPlayer.getCurrentTime()); }, 200);
  }

  function updateTimestampReadout(value) { const seconds = Math.max(0, Number(value) || 0); $("timestampReadout").textContent = `${seconds.toFixed(1)} seconds · ${formatTimestamp(seconds)}`; }
  function captureTimestamp(field) {
    if (!editorPlayer?.getCurrentTime) { $("editorStatus").textContent = "Load the video first."; return; }
    const value = Math.round(editorPlayer.getCurrentTime() * 10) / 10; $(field).value = formatTimestamp(value); updateTimestampReadout(value); syncEditorQuestion();
  }
  function destroyEditorPlayer() {
    if (metadataTimer !== null) window.clearTimeout(metadataTimer); metadataTimer = null; metadataTarget = null;
    if (editorTick !== null) window.clearInterval(editorTick); editorTick = null;
    if (editorPlayer?.destroy) editorPlayer.destroy(); editorPlayer = null;
    const stage = document.querySelector(".editor-player");
    if (stage && !$("editorYoutubePlayer")) { const target = document.createElement("div"); target.id = "editorYoutubePlayer"; stage.append(target); }
  }

  function exportQuiz() {
    syncEditorQuestion(); editorDraft.title = $("editorTitle").value; editorDraft.categories = [...new Set(editorDraft.questions.map((q) => q.category))];
    const blob = new Blob([JSON.stringify(editorDraft, null, 2)], { type: "application/json" }); const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = `${editorDraft.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "music-quiz"}.json`; link.click(); URL.revokeObjectURL(link.href);
  }

  function importQuiz(file) {
    if (!file) return; const reader = new FileReader();
    reader.onload = () => { try { const imported = JSON.parse(reader.result); const error = validateQuiz(imported); if (error) throw new Error(error); editorDraft = normalizeQuiz(imported); editorIndex = 0; $("editorTitle").value = editorDraft.title; renderEditorList(); loadEditorQuestion(); toast("Quiz imported. Press Save quiz to apply it."); } catch (error) { $("editorStatus").textContent = `Import failed: ${error.message}`; $("editorStatus").classList.add("error"); } };
    reader.onerror = () => { $("editorStatus").textContent = "The selected file could not be read."; }; reader.readAsText(file); $("importFile").value = "";
  }

  listen("playButton", "click", togglePlay); listen("readyPlayButton", "click", togglePlay); listen("stopButton", "click", () => { stopPlayback(); setStatus("Stopped."); });
  listen("restartButton", "click", () => playSegment()); listen("revealButton", "click", revealAnswer); listen("playAnswerButton", "click", () => playSegment("answer"));
  listen("backButton", "click", closeQuestion); listen("noPointsButton", "click", () => { pendingAwards = game.teams.map(() => 0); renderScoreButtons(); }); listen("awardPointsButton", "click", () => finishQuestion(true));
  listen("resetButton", "click", resetGame); listen("settingsButton", "click", openEditor);
  listen("teamCount", "change", (event) => setTeamCount(event.target.value));
  listen("editorForm", "submit", saveEditor); listen("cancelEditorButton", "click", closeEditor); listen("discardEditorButton", "click", closeEditor);
  listen("loadEditorVideo", "click", () => loadEditorVideo(false)); listen("editYoutube", "input", scheduleMetadataLookup); listen("setStartButton", "click", () => captureTimestamp("editStart")); listen("setStopButton", "click", () => captureTimestamp("editStop")); listen("setRevealStartButton", "click", () => captureTimestamp("editRevealStart"));
  listen("exportButton", "click", exportQuiz); listen("importButton", "click", () => $("importFile")?.click()); listen("importFile", "change", (event) => importQuiz(event.target.files[0]));
  listen("loadLibraryQuizButton", "click", loadSelectedLibraryQuiz);
  document.addEventListener("keydown", (event) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.target.isContentEditable || !$("editorView").hidden) return;
    if (event.key === "Escape" && activeIndex !== null) closeQuestion();
    if (activeIndex === null) return;
    if (event.code === "Space") { event.preventDefault(); togglePlay(); }
    if (event.key.toLowerCase() === "r") playSegment();
    if (event.key.toLowerCase() === "a") revealAnswer();
  });
  window.addEventListener("beforeunload", () => { stopPlayback(); destroyEditorPlayer(); });

  async function initialize() {
    const customQuiz = loadCustomQuiz(); await loadQuizLibrary();
    if (customQuiz) quiz = normalizeQuiz(customQuiz);
    else {
      const defaultEntry = quizLibrary.find((entry) => entry.default === true) || quizLibrary[0];
      if (defaultEntry) {
        try { quiz = await fetchQuizJson(libraryQuizUrl(defaultEntry.file)); }
        catch (error) { console.warn("Music Quiz: default save could not be loaded; using quiz-data.js.", error); quiz = normalizeQuiz(clone(QUIZ)); }
      }
    }
    game = loadGame(); render(); showView("board");
  }

  initialize();
})();
