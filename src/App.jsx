import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./supabase.js";

const EXPENSE_CATS = ["식비", "카페", "교통", "쇼핑", "생활", "의료", "육아", "경조사", "문화", "기타"];
const INCOME_CATS = ["월급", "용돈", "부수입", "기타"];
const CAT_EMOJI = {
  식비: "🍚", 카페: "☕", 교통: "🚕", 쇼핑: "🛍️", 생활: "🏠", 의료: "💊", 육아: "👶", 경조사: "🎁", 문화: "🎬",
  월급: "💼", 용돈: "💵", 부수입: "💰", 기타: "📦",
};
const CAT_COLOR = ["#e8865a", "#5aa7e8", "#63c187", "#c77dd6", "#e0b64a", "#e8724a", "#7d8fd6", "#9aa0a6", "#d69a7d", "#7dc7c0"];

// 지출 대상(누구를 위해). 대표님/현욱님 = 개인 지출(본인 용돈), 나머지 = 공용.
const BENEFICIARIES = ["온가족", "부부", "유찬이", "대표님", "현욱님"];
const BEN_EMOJI = { 온가족: "👨‍👩‍👦", 부부: "💑", 유찬이: "👶", 대표님: "👩", 현욱님: "👨" };
const PERSONAL = ["대표님", "현욱님"]; // 개인 용돈에 카운트되는 대상
const ALLOWANCE = 500000; // 1인 월 개인 용돈 예산

// 이메일 → 사람 매핑 (RLS의 current_person()과 동일 규칙)
const EMAIL_PERSON = { "jjiiyyuu@gmail.com": "대표님", "hwle1125@gmail.com": "현욱님" };
const REDIRECT_TO = window.location.origin + "/zzanji/";

const won = (n) => (n < 0 ? "-" : "") + "₩" + Math.abs(n).toLocaleString("ko-KR");
const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const curMonth = () => todayStr().slice(0, 7);
const monthLabel = (m) => `${m.slice(0, 4)}년 ${Number(m.slice(5, 7))}월`;
const shiftMonth = (m, delta) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!authReady) return <Splash text="불러오는 중…" />;
  if (!session) return <Login />;

  const email = (session.user?.email || "").toLowerCase();
  const myPerson = EMAIL_PERSON[email] || null;
  if (!myPerson) return <NotAllowed email={session.user?.email} />;

  return <Ledger myPerson={myPerson} />;
}

function Ledger({ myPerson }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(curMonth());
  const [tab, setTab] = useState("ledger");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ date: todayStr(), type: "expense", amount: "", category: "식비", item: "", beneficiary: "온가족" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from("ledger").select("*").order("date", { ascending: false }).order("created_at", { ascending: false });
    if (!error && data) setEntries(data);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
    // 탭 다시 볼 때 자동 새로고침
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    // 실시간: 짠지봇/다른 기기에서 바뀌면 바로 반영
    const ch = supabase.channel("ledger-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "ledger" }, () => load())
      .subscribe();
    return () => { document.removeEventListener("visibilitychange", onVis); supabase.removeChannel(ch); };
  }, [load]);

  const monthEntries = useMemo(() => entries.filter((e) => (e.date || "").startsWith(month)), [entries, month]);
  const totals = useMemo(() => {
    let expense = 0, income = 0;
    for (const e of monthEntries) { if (e.type === "income") income += e.amount; else expense += e.amount; }
    return { expense, income, balance: income - expense };
  }, [monthEntries]);

  const byCategory = useMemo(() => {
    const map = {};
    for (const e of monthEntries) { if (e.type === "expense") map[e.category] = (map[e.category] || 0) + e.amount; }
    const arr = Object.entries(map).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
    const max = arr.length ? arr[0].amount : 0;
    return { arr, max };
  }, [monthEntries]);

  const trend = useMemo(() => {
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(shiftMonth(curMonth(), -i));
    const data = months.map((m) => {
      const exp = entries.filter((e) => e.type === "expense" && (e.date || "").startsWith(m)).reduce((s, e) => s + e.amount, 0);
      return { m, exp };
    });
    const max = Math.max(1, ...data.map((d) => d.exp));
    return { data, max };
  }, [entries]);

  // 개인 용돈: 내가 대상인 지출 (RLS로 상대 개인지출은 애초에 안 옴)
  const myPersonal = useMemo(() => {
    const list = monthEntries.filter((e) => e.type === "expense" && e.beneficiary === myPerson);
    const spent = list.reduce((s, e) => s + e.amount, 0);
    return { list, spent, remain: ALLOWANCE - spent, pct: Math.min(100, Math.round((spent / ALLOWANCE) * 100)) };
  }, [monthEntries, myPerson]);

  const cats = form.type === "income" ? INCOME_CATS : EXPENSE_CATS;

  const submit = async () => {
    const amt = parseInt(String(form.amount).replace(/[^0-9]/g, ""), 10);
    if (!amt || amt <= 0) { alert("금액을 입력해 주세요."); return; }
    setSaving(true);
    const row = {
      date: form.date, type: form.type, amount: amt, category: form.category,
      item: form.item.trim() || null, who: myPerson,
      beneficiary: form.type === "expense" ? form.beneficiary : "온가족",
    };
    const { data, error } = await supabase.from("ledger").insert(row).select().single();
    setSaving(false);
    if (error) { alert("저장에 실패했어요. 다시 시도해 주세요."); return; }
    setEntries((prev) => [data, ...prev]);
    setForm((f) => ({ ...f, amount: "", item: "" }));
    setAdding(false);
    setMonth(form.date.slice(0, 7));
  };

  const remove = async (id) => {
    if (!window.confirm("이 내역을 삭제할까요?")) return;
    setEntries((prev) => prev.filter((e) => e.id !== id));
    await supabase.from("ledger").delete().eq("id", id);
  };

  return (
    <div style={wrap}>
      <header style={head}>
        <div style={{ fontSize: 26 }}>🥬</div>
        <h1 style={h1}>짠지</h1>
        <p style={{ margin: "3px 0 0", color: "#b3a99a", fontSize: 12.5 }}>유찬이네 가계부 · {myPerson}</p>
        <button style={refreshBtn} onClick={load} title="새로고침">{loading ? "⏳" : "🔄"}</button>
        <button style={logoutBtn} onClick={() => supabase.auth.signOut()}>로그아웃</button>
      </header>

      {/* 탭 */}
      <div style={tabBar}>
        {[["ledger", "📒 가계부"], ["allowance", "💵 용돈"]].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{ ...tabBtn, ...(tab === t ? tabBtnOn : {}) }}>{label}</button>
        ))}
      </div>

      {/* 월 선택 */}
      <div style={monthBar}>
        <button style={arrow} onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
        <span style={{ fontWeight: 800, fontSize: 16 }}>{monthLabel(month)}</span>
        <button style={arrow} onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={month >= curMonth()}>›</button>
      </div>

      {tab === "ledger" ? (
        <>
          {/* 요약 */}
          <div style={summaryRow}>
            <div style={{ ...sumCard, background: "#fdeee9" }}>
              <span style={sumLabel}>지출</span>
              <span style={{ ...sumVal, color: "#d9663f" }}>{won(totals.expense)}</span>
            </div>
            <div style={{ ...sumCard, background: "#e7f2ea" }}>
              <span style={sumLabel}>수입</span>
              <span style={{ ...sumVal, color: "#3f8f52" }}>{won(totals.income)}</span>
            </div>
          </div>
          <div style={balanceCard}>
            <span style={{ color: "#8a8170", fontSize: 13 }}>이번 달 잔액</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: totals.balance < 0 ? "#d9663f" : "#4a4438" }}>{won(totals.balance)}</span>
          </div>

          {/* 카테고리별 */}
          <section style={card}>
            <h2 style={h2}>카테고리별 지출</h2>
            {byCategory.arr.length === 0 ? (
              <p style={empty}>이번 달 지출 내역이 없어요.</p>
            ) : (
              byCategory.arr.map((c, i) => (
                <div key={c.category} style={{ marginBottom: 11 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, marginBottom: 4 }}>
                    <span>{CAT_EMOJI[c.category] || "📦"} {c.category}</span>
                    <span style={{ fontWeight: 700 }}>{won(c.amount)}</span>
                  </div>
                  <div style={barTrack}>
                    <div style={{ ...barFill, width: `${(c.amount / byCategory.max) * 100}%`, background: CAT_COLOR[i % CAT_COLOR.length] }} />
                  </div>
                </div>
              ))
            )}
          </section>

          {/* 월별 추이 */}
          <section style={card}>
            <h2 style={h2}>최근 6개월 지출 추이</h2>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 110, marginTop: 6 }}>
              {trend.data.map((d) => (
                <div key={d.m} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                  <div style={{ fontSize: 10, color: "#8a8170" }}>{d.exp ? Math.round(d.exp / 10000) + "만" : ""}</div>
                  <div style={{ width: "70%", height: `${(d.exp / trend.max) * 78}px`, minHeight: 3, background: d.m === month ? "#e8865a" : "#e6c9ba", borderRadius: 6 }} />
                  <div style={{ fontSize: 10.5, color: d.m === month ? "#d9663f" : "#b3a99a", fontWeight: d.m === month ? 800 : 500 }}>{Number(d.m.slice(5))}월</div>
                </div>
              ))}
            </div>
          </section>

          {/* 내역 리스트 */}
          <section style={card}>
            <h2 style={h2}>내역 <span style={{ color: "#b3a99a", fontSize: 13, fontWeight: 500 }}>{monthEntries.length}건</span></h2>
            {loading ? <p style={empty}>불러오는 중…</p> : monthEntries.length === 0 ? (
              <p style={empty}>내역이 없어요. + 버튼으로 추가해 보세요!</p>
            ) : (
              monthEntries.map((e) => (
                <div key={e.id} style={entryRow}>
                  <span style={{ fontSize: 20 }}>{CAT_EMOJI[e.category] || "📦"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>{e.item || e.category}</div>
                    <div style={{ fontSize: 11.5, color: "#b3a99a" }}>
                      {e.date?.slice(5).replace("-", ".")} · {e.category}
                      {e.beneficiary ? ` · ${BEN_EMOJI[e.beneficiary] || ""}${e.beneficiary}` : ""}
                    </div>
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 800, color: e.type === "income" ? "#3f8f52" : "#4a4438", whiteSpace: "nowrap" }}>
                    {e.type === "income" ? "+" : "-"}{won(e.amount).replace("₩", "")}
                  </span>
                  <button onClick={() => remove(e.id)} style={delBtn}>×</button>
                </div>
              ))
            )}
          </section>
        </>
      ) : (
        <>
          {/* 개인 용돈 탭 */}
          <section style={card}>
            <h2 style={h2}>{myPerson} 개인 용돈</h2>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: myPersonal.remain < 0 ? "#d9663f" : "#4a4438" }}>{won(myPersonal.spent)}</span>
              <span style={{ fontSize: 13, color: "#8a8170" }}>/ {won(ALLOWANCE)}</span>
            </div>
            <div style={{ ...barTrack, height: 12 }}>
              <div style={{ ...barFill, width: `${myPersonal.pct}%`, background: myPersonal.pct >= 100 ? "#d9663f" : myPersonal.pct >= 80 ? "#e0a04a" : "#63c187" }} />
            </div>
            <p style={{ margin: "10px 2px 0", fontSize: 13, color: myPersonal.remain < 0 ? "#d9663f" : "#8a8170", fontWeight: 600 }}>
              {myPersonal.remain >= 0 ? `이번 달 ${won(myPersonal.remain)} 남았어요` : `예산을 ${won(-myPersonal.remain)} 초과했어요 😰`}
            </p>
          </section>

          <section style={card}>
            <h2 style={h2}>내 개인 지출 <span style={{ color: "#b3a99a", fontSize: 13, fontWeight: 500 }}>{myPersonal.list.length}건</span></h2>
            {myPersonal.list.length === 0 ? (
              <p style={empty}>이번 달 개인 지출이 없어요. 알뜰하시네요! 🥬</p>
            ) : (
              myPersonal.list.map((e) => (
                <div key={e.id} style={entryRow}>
                  <span style={{ fontSize: 20 }}>{CAT_EMOJI[e.category] || "📦"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>{e.item || e.category}</div>
                    <div style={{ fontSize: 11.5, color: "#b3a99a" }}>{e.date?.slice(5).replace("-", ".")} · {e.category}</div>
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "#4a4438", whiteSpace: "nowrap" }}>-{won(e.amount).replace("₩", "")}</span>
                  <button onClick={() => remove(e.id)} style={delBtn}>×</button>
                </div>
              ))
            )}
          </section>

          <p style={{ ...empty, fontSize: 12 }}>🔒 배우자의 개인 지출은 프라이버시라서 보이지 않아요.</p>
        </>
      )}

      {/* 추가 버튼 */}
      <button style={fab} onClick={() => { setForm((f) => ({ ...f, date: todayStr(), amount: "", item: "" })); setAdding(true); }}>+</button>

      {/* 입력 시트 */}
      {adding && (
        <div style={overlay} onClick={() => setAdding(false)}>
          <div style={sheet} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 17, textAlign: "center", marginBottom: 16 }}>내역 추가</div>

            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {[["expense", "지출"], ["income", "수입"]].map(([t, label]) => (
                <button key={t} onClick={() => setForm((f) => ({ ...f, type: t, category: (t === "income" ? INCOME_CATS : EXPENSE_CATS)[0] }))}
                  style={{ ...typeBtn, ...(form.type === t ? (t === "income" ? typeIncomeOn : typeExpenseOn) : {}) }}>{label}</button>
              ))}
            </div>

            <input inputMode="numeric" placeholder="금액 (예: 6000)" value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value.replace(/[^0-9]/g, "") }))}
              style={{ ...input, fontSize: 20, fontWeight: 800, textAlign: "center" }} autoFocus />

            <input placeholder="항목 (예: 스타벅스)" value={form.item}
              onChange={(e) => setForm((f) => ({ ...f, item: e.target.value }))} style={input} />

            <div style={{ fontSize: 12.5, color: "#8a8170", margin: "6px 2px 6px", fontWeight: 600 }}>카테고리</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 12 }}>
              {cats.map((c) => (
                <button key={c} onClick={() => setForm((f) => ({ ...f, category: c }))}
                  style={{ ...catChip, ...(form.category === c ? catChipOn : {}) }}>{CAT_EMOJI[c]} {c}</button>
              ))}
            </div>

            {form.type === "expense" && (
              <>
                <div style={{ fontSize: 12.5, color: "#8a8170", margin: "6px 2px 6px", fontWeight: 600 }}>누구를 위해? (대상)</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 12 }}>
                  {BENEFICIARIES.map((b) => (
                    <button key={b} onClick={() => setForm((f) => ({ ...f, beneficiary: b }))}
                      style={{ ...catChip, ...(form.beneficiary === b ? catChipOn : {}) }}>{BEN_EMOJI[b]} {b}</button>
                  ))}
                </div>
                {PERSONAL.includes(form.beneficiary) && (
                  <p style={{ fontSize: 11.5, color: "#b3a99a", margin: "0 2px 12px" }}>💡 개인 지출로 기록돼서 {form.beneficiary} 용돈에서 차감돼요.</p>
                )}
              </>
            )}

            <input type="date" value={form.date} max={todayStr()}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} style={input} />

            <button style={{ ...saveBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={submit}>
              {saving ? "저장 중…" : "저장하기"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 로그인 / 상태 화면 ──
function Login() {
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: REDIRECT_TO } });
    if (error) { setBusy(false); alert("로그인에 실패했어요. 다시 시도해 주세요."); }
  };
  return (
    <div style={{ ...wrap, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", paddingBottom: 0 }}>
      <div style={{ fontSize: 46 }}>🥬</div>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "12px 0 2px" }}>짠지</h1>
      <p style={{ color: "#8a8170", fontSize: 14, margin: "0 0 30px" }}>유찬이네 가계부</p>
      <button onClick={signIn} disabled={busy} style={googleBtn}>
        <span style={{ fontSize: 18 }}>🔵</span> {busy ? "이동 중…" : "구글로 로그인"}
      </button>
      <p style={{ color: "#b3a99a", fontSize: 12, margin: "18px 20px 0", textAlign: "center" }}>대표님·현욱님만 로그인할 수 있어요 🔒</p>
    </div>
  );
}

function Splash({ text }) {
  return (
    <div style={{ ...wrap, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", paddingBottom: 0 }}>
      <div style={{ fontSize: 40 }}>🥬</div>
      <p style={{ color: "#8a8170", fontSize: 14, marginTop: 12 }}>{text}</p>
    </div>
  );
}

function NotAllowed({ email }) {
  return (
    <div style={{ ...wrap, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", paddingBottom: 0, textAlign: "center" }}>
      <div style={{ fontSize: 40 }}>🚫</div>
      <p style={{ color: "#4a4438", fontSize: 15, fontWeight: 700, margin: "12px 20px 4px" }}>접근 권한이 없어요</p>
      <p style={{ color: "#b3a99a", fontSize: 12.5, margin: "0 20px 24px" }}>{email || ""}<br />이 계정은 유찬이네 가계부 멤버가 아니에요.</p>
      <button onClick={() => supabase.auth.signOut()} style={googleBtn}>다른 계정으로</button>
    </div>
  );
}

// ── 스타일 ──
const wrap = { maxWidth: 520, margin: "0 auto", minHeight: "100vh", background: "#faf7f2", color: "#4a4438", fontFamily: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif', padding: "0 16px 90px", position: "relative" };
const head = { textAlign: "center", padding: "24px 0 8px", position: "relative" };
const h1 = { fontSize: 22, fontWeight: 800, margin: "4px 0 0" };
const logoutBtn = { position: "absolute", top: 20, right: 4, background: "none", border: "none", color: "#b3a99a", fontSize: 12, cursor: "pointer", textDecoration: "underline" };
const refreshBtn = { position: "absolute", top: 16, left: 4, background: "none", border: "none", fontSize: 18, cursor: "pointer", lineHeight: 1 };
const tabBar = { display: "flex", gap: 8, marginBottom: 14 };
const tabBtn = { flex: 1, padding: "10px 0", borderRadius: 12, border: "1px solid #ece3da", background: "#fff", color: "#8a8170", fontSize: 14.5, fontWeight: 700, cursor: "pointer" };
const tabBtnOn = { background: "#4a4438", color: "#fff", borderColor: "#4a4438" };
const monthBar = { display: "flex", alignItems: "center", justifyContent: "center", gap: 18, margin: "0 0 16px" };
const arrow = { width: 34, height: 34, borderRadius: 10, border: "1px solid #ece3da", background: "#fff", color: "#8a8170", fontSize: 20, cursor: "pointer" };
const summaryRow = { display: "flex", gap: 10, marginBottom: 10 };
const sumCard = { flex: 1, borderRadius: 16, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 };
const sumLabel = { fontSize: 12.5, color: "#8a8170", fontWeight: 600 };
const sumVal = { fontSize: 18, fontWeight: 800 };
const balanceCard = { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", border: "1px solid #ece3da", borderRadius: 16, padding: "13px 16px", marginBottom: 18 };
const card = { background: "#fff", border: "1px solid #ece3da", borderRadius: 18, padding: "16px 16px", marginBottom: 14 };
const h2 = { fontSize: 15, fontWeight: 700, margin: "0 0 12px" };
const empty = { color: "#b3a99a", fontSize: 13.5, textAlign: "center", padding: "14px 0", margin: 0 };
const barTrack = { height: 9, background: "#f2ebe3", borderRadius: 999, overflow: "hidden" };
const barFill = { height: "100%", borderRadius: 999 };
const entryRow = { display: "flex", alignItems: "center", gap: 11, padding: "10px 0", borderBottom: "1px solid #f2ebe3" };
const delBtn = { background: "none", border: "none", color: "#d0c6ba", fontSize: 20, cursor: "pointer", lineHeight: 1, padding: "0 2px" };
const fab = { position: "fixed", right: "max(20px, calc(50% - 260px + 20px))", bottom: 24, width: 58, height: 58, borderRadius: 999, border: "none", background: "#e8865a", color: "#fff", fontSize: 30, fontWeight: 300, cursor: "pointer", boxShadow: "0 6px 18px rgba(232,134,90,0.45)", zIndex: 5 };
const overlay = { position: "fixed", inset: 0, background: "rgba(40,34,28,0.4)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 10 };
const sheet = { width: "100%", maxWidth: 520, background: "#faf7f2", borderRadius: "22px 22px 0 0", padding: "22px 18px calc(24px + env(safe-area-inset-bottom))", maxHeight: "88vh", overflowY: "auto" };
const input = { width: "100%", boxSizing: "border-box", border: "1.5px solid #ece3da", borderRadius: 12, padding: "13px 14px", fontSize: 15, marginBottom: 10, color: "#4a4438", background: "#fff", outline: "none", fontFamily: "inherit" };
const typeBtn = { flex: 1, padding: "11px 0", borderRadius: 12, border: "1px solid #ece3da", background: "#fff", color: "#8a8170", fontSize: 14.5, fontWeight: 700, cursor: "pointer" };
const typeExpenseOn = { background: "#d9663f", color: "#fff", borderColor: "#d9663f" };
const typeIncomeOn = { background: "#3f8f52", color: "#fff", borderColor: "#3f8f52" };
const catChip = { border: "1px solid #ece3da", background: "#fff", color: "#6a6155", fontSize: 13, fontWeight: 600, padding: "8px 12px", borderRadius: 999, cursor: "pointer" };
const catChipOn = { background: "#4a4438", color: "#fff", borderColor: "#4a4438" };
const saveBtn = { width: "100%", marginTop: 6, padding: "15px 0", borderRadius: 14, border: "none", background: "#e8865a", color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer" };
const googleBtn = { display: "flex", alignItems: "center", gap: 10, padding: "14px 28px", borderRadius: 14, border: "1px solid #ece3da", background: "#fff", color: "#4a4438", fontSize: 15.5, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,0.06)" };
