// ☁️ 올댓메시지 웹판 — 구글 로그인 + Firestore 동기화
// 클라우드에는 「일정·요약」만 올려요: 날짜·시간·제목·한 줄 요약·장소·분류·마감 여부·완료 여부·할 일.
// 메시지 원문(src)·메시지함·보낸 사람·전화번호는 올리지 않고, 글자는 올리기 전에 이름·전화번호를 ○○○로 가려요.
// 저장 위치: users/{내 uid}/events/{일정 id}  (firestore.rules 로 본인만 읽고 쓰기)

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const B = window.allthatBridge;
const CFG = window.ALLTHAT_FIREBASE;
const OWNER = 'allthat-web-owner';            // 이 브라우저의 일정이 어느 계정 것인지
const MAPK = uid => 'allthat-web-sync:' + uid; // 마지막으로 맞춘 내용 (일정 id → 지문)

/* ---------- 올릴 모양 만들기 (여기에 없는 칸은 절대 올라가지 않음) ---------- */
const txt = (s, n) => B.mask(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, n);
const okDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : '';
export function cloudDoc(e) {
  return {
    date: okDate(e.date), endDate: okDate(e.endDate),
    time: /^\d{1,2}:\d{2}$/.test(e.time || '') ? e.time : '',
    period: String(e.period || '').replace(/\s+/g, ' ').trim().slice(0, 20), title: txt(e.title, 80), summary: txt(e.aiSum, 120), place: txt(e.place, 40),
    category: ['제출·마감', '회의·연수', '행사·학사', '일정'].includes(e.category) ? e.category : '일정',
    deadline: !!e.deadline, done: !!e.done,
    todos: (Array.isArray(e.todos) ? e.todos : []).slice(0, 20).map(t => ({ t: txt(typeof t === 'string' ? t : t.t, 80), done: !!(t && t.done) })),
  };
}
const FIELDS = ['date', 'endDate', 'time', 'period', 'title', 'summary', 'place', 'category', 'deadline', 'done', 'todos'];
const pick = d => Object.fromEntries(FIELDS.map(k => [k, d[k]]));
const print = d => JSON.stringify(FIELDS.map(k => d[k] === undefined ? null : d[k]));
const loadMap = uid => { try { return JSON.parse(localStorage.getItem(MAPK(uid))) || {}; } catch (e) { return {}; } };
const saveMap = (uid, m) => { try { localStorage.setItem(MAPK(uid), JSON.stringify(m)); } catch (e) {} };
// 이 브라우저의 일정을 비울 때는 「맞춘 기록」도 함께 지워야 해요.
// (안 지우면 빈 목록을 「모두 지웠다」로 오해해 클라우드 일정까지 지울 수 있어요)
function resetLocalAll() {
  B.resetLocal();
  try { Object.keys(localStorage).filter(k => k.startsWith('allthat-web-sync:')).forEach(k => localStorage.removeItem(k)); } catch (e) {}
}

if (!B || B.demo) { /* 🎬 데모: 클라우드를 쓰지 않음 */ }
else if (!CFG || !CFG.apiKey || !CFG.projectId) B.cloudUi('off');
else start().catch(e => { console.error(e); B.cloudUi('err', '클라우드 도구를 불러오지 못했어요'); });

async function start() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
  const app = initializeApp(CFG), auth = A.getAuth(app), db = F.getFirestore(app);
  let user = null, unsub = null, ready = false, timer = null, busy = false, again = false;
  const col = () => F.collection(db, 'users', user.uid, 'events');

  async function push() {
    if (!user || !ready) return;
    if (busy) { again = true; return; }
    busy = true; B.cloudUi('sync');
    try {
      const map = loadMap(user.uid), local = new Map(B.events().filter(e => e && e.id && !e.ac && okDate(e.date)).map(e => [String(e.id), e]));
      const ops = [];
      local.forEach((e, id) => { const d = cloudDoc(e), h = print(d); if (map[id] !== h) ops.push(['set', id, d, h]); });
      const dels = Object.keys(map).filter(id => !local.has(id));
      // 🛡 안전장치: 한꺼번에 많이 없어졌으면(3개 이상이면서 전체의 30% 넘게, 또는 이 브라우저 목록이 비었으면) 지우기 전에 묻기
      const known = Object.keys(map).length;
      if (dels.length >= 3 && (local.size === 0 || dels.length > known * 0.3)) {
        const ok = confirm(`이 브라우저에서 일정 ${dels.length}개가 한꺼번에 없어졌어요.\n\n확인: 클라우드(휴대폰 등)에서도 지워요\n취소: 지우지 않고, 클라우드에 있는 일정을 이 브라우저로 다시 받아 와요`);
        if (!ok) { busy = false; restart(); return; }
      }
      dels.forEach(id => ops.push(['del', id]));
      for (let i = 0; i < ops.length; i += 400) {
        const b = F.writeBatch(db);
        ops.slice(i, i + 400).forEach(([k, id, d]) => k === 'set' ? b.set(F.doc(col(), id), { ...d, updatedAt: F.serverTimestamp() }) : b.delete(F.doc(col(), id)));
        await b.commit();
        ops.slice(i, i + 400).forEach(([k, id, , h]) => { if (k === 'set') map[id] = h; else delete map[id]; });
        saveMap(user.uid, map);
      }
      B.cloudUi('ok', user);
    } catch (e) { console.error(e); B.cloudUi('err', '올리지 못했어요 · 인터넷 연결을 확인해 주세요'); }
    busy = false;
    if (again) { again = false; push(); }
  }

  function listen() {
    unsub = F.onSnapshot(col(), snap => {
      const map = loadMap(user.uid);
      const adds = [], updates = [], removes = [];
      const local = new Map(B.events().map(e => [String(e.id), e]));
      snap.docChanges().forEach(ch => {
        if (ch.doc.metadata.hasPendingWrites) return;          // 내가 방금 올린 것
        const id = ch.doc.id, d = pick(ch.doc.data()), h = print(d), loc = local.get(id);
        if (ch.type === 'removed') {
          // 다른 기기에서 지움 → 이 브라우저에서 고치지 않은 일정이면 같이 지움
          if (loc && map[id] !== undefined && print(cloudDoc(loc)) === map[id]) removes.push(id);
          delete map[id]; return;
        }
        if (!loc) { if (map[id] === undefined) adds.push({ id, ...d }); }    // 다른 기기에서 만든 일정
        else if (h !== map[id] && (map[id] === undefined || print(cloudDoc(loc)) === map[id])) updates.push({ id, ...d });
        map[id] = h;
      });
      saveMap(user.uid, map);
      if (adds.length || updates.length || removes.length) B.applyRemote({ adds, updates, removes });
      if (!ready) { ready = true; push(); } else B.cloudUi('ok', user);
    }, e => { console.error(e); B.cloudUi('err', '클라우드 일정을 읽지 못했어요'); });
  }

  // 「맞춘 기록」을 버리고 처음부터 다시 맞추기: 클라우드에만 있는 일정은 받아 오고, 이 브라우저에만 있는 일정은 올림 (지우지 않음)
  function restart() {
    if (!user) return;
    try { localStorage.removeItem(MAPK(user.uid)); } catch (e) {}
    if (unsub) { unsub(); unsub = null; }
    ready = false; B.cloudUi('sync'); listen();
  }

  A.onAuthStateChanged(auth, async u => {
    if (unsub) { unsub(); unsub = null; }
    user = null; ready = false;
    if (!u) { B.cloudUi('out'); return; }
    let owner = ''; try { owner = localStorage.getItem(OWNER) || ''; } catch (e) {}
    if (owner && owner !== u.uid && B.hasLocal()) {
      // 이 브라우저에는 다른 계정의 일정이 있음 → 섞이지 않게 묻기
      if (!confirm('이 브라우저에는 다른 구글 계정의 일정이 들어 있어요.\n\n이 계정으로 바꾸면 이 브라우저의 일정·메시지를 비우고, 이 계정의 클라우드 일정을 받아 와요.\n(원문 메시지는 클라우드에 없으니, 필요하면 먼저 ⚙ 설정 → 💾 백업 저장을 해 두세요.)\n\n바꿀까요?')) { await A.signOut(auth); return; }
      resetLocalAll();
    }
    try { localStorage.setItem(OWNER, u.uid); } catch (e) {}
    // 🛡 이 브라우저 목록이 비어 있는데 예전 맞춘 기록만 남아 있으면(저장 공간이 지워진 경우 등) 기록을 버림 → 클라우드 일정을 지우지 않고 다시 받아 옴
    if (!B.hasLocal()) { try { localStorage.removeItem(MAPK(u.uid)); } catch (e) {} }
    user = u; B.cloudUi('sync'); listen();
  });

  window.allthatCloud = {
    queue() { clearTimeout(timer); timer = setTimeout(push, 1500); },
    async signIn() {
      try { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); }
      catch (e) {
        const c = e.code || '';
        B.cloudUi('out');
        if (/popup-blocked/.test(c)) B.toast('로그인 창이 막혔어요. 주소창 오른쪽의 팝업 차단 표시에서 「허용」을 누른 뒤 다시 눌러 주세요.');
        else if (/unauthorized-domain/.test(c)) B.toast('이 주소는 아직 로그인이 허용되지 않았어요. (Firebase → Authentication → 설정 → 승인된 도메인)');
        else if (!/popup-closed|cancelled-popup/.test(c)) { console.error(e); B.toast('로그인하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.'); }
      }
    },
    signedIn: () => !!user,
    // 목록이 통째로 바뀔 때(N 드라이브·백업 불러오기) 부르기: 없어진 일정을 클라우드에서 지우지 않고 다시 받아 옴
    forget() { restart(); },
    async signOut(clearLocal) {
      clearTimeout(timer); if (user && ready) await push();
      await A.signOut(auth);
      if (clearLocal) { resetLocalAll(); try { localStorage.removeItem(OWNER); } catch (e) {} }
    },
  };
  B.cloudUi(auth.currentUser ? 'sync' : 'out');
}
