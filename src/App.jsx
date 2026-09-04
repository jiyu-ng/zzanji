import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./supabase.js";

const EXPENSE_CATS = ["식비", "카페", "교통", "쇼핑", "생활", "의료", "육아", "경조사", "문화", "구독", "미용", "기타"];
const INCOME_CATS = ["월급", "용돈", "부수입", "기타"];
const CAT_EMOJI = {
  식비: "🍚", 카페: "☕", 교통: "🚕", 쇼핑: "🛍️", 생활: "🏠", 의료: "💊", 육아: "👶", 경조사: "🎁", 문화: "🎬", 구독: "🔁", 미용: "💄",
  월급: "💼", 용돈: "💵", 부수입: "💰", 기타: "📦",
};
const CAT_COLOR = ["#e8865a", "#5aa7e8", "#63c187", "#c77dd6", "#e0b64a", "#e8724a", "#7d8fd6", "#9aa0a6", "#d69a7d", "#7dc7c0"];

// 지출 대상(누구를 위해). 대표님/현욱님 = 개인 지출(본인 용돈), 나머지 = 공용.
const BENEFICIARIES = ["온가족", "부부", "유찬이", "콩떡이", "대표님", "현욱님"];
const BEN_EMOJI = { 온가족: "👨‍👩‍👦", 부부: "💑", 유찬이: "👶", 콩떡이: "🐱", 대표님: "👩", 현욱님: "👨" };
const WHO_EMOJI = { 대표님: "👩", 현욱님: "👨" };
const CARD_EMOJI = { 우리카드: "💳", 토스모임카드: "🤝", 현대카드: "🚗", "IBK 계좌이체": "🏦", 미지정: "❓" };
// 앱 표시용 이름 (데이터는 '대표님', 화면엔 '지유님')
const disp = (s) => (s === "대표님" ? "지유님" : s);
const emojiFor = (k) => BEN_EMOJI[k] || WHO_EMOJI[k] || CARD_EMOJI[k] || "";
const PERSONAL = ["대표님", "현욱님"]; // 개인 용돈에 카운트되는 대상
// 프라이버시·용돈 판별 = '카드(누구 돈)' 기준. 개인카드 소유자 매핑.
const CARD_OWNER = { "우리카드": "대표님", "IBK 계좌이체": "대표님", "IBK 계좌": "대표님", "카카오페이": "대표님", "카카오페이 생활비계좌": "대표님", "카카오뱅크": "현욱님" };
const cardOwner = (e) => CARD_OWNER[e.card] || null; // 개인카드면 소유자, 공용카드/null이면 null(공용)
const isPersonal = (e) => cardOwner(e) != null; // 누군가의 개인카드 지출(가계부 탭 제외용)
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
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(curMonth());
  const [tab, setTab] = useState("ledger");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ date: todayStr(), type: "expense", amount: "", category: "식비", item: "", beneficiary: "온가족" });
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [led, ast] = await Promise.all([
      supabase.from("ledger").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
      supabase.from("asset_snapshot").select("*").order("date", { ascending: false }),
    ]);
    if (!led.error && led.data) setEntries(led.data);
    if (!ast.error && ast.data) setAssets(ast.data);
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
  // [가계부] 탭 = 공용 살림만 (개인 용돈 제외, '제외' 카테고리 제외 - 큰 일회성/엄마집 등)
  const household = useMemo(() => monthEntries.filter((e) => !isPersonal(e) && e.category !== "제외"), [monthEntries]);
  const totals = useMemo(() => {
    let expense = 0, income = 0;
    for (const e of household) { if (e.type === "income") income += e.amount; else expense += e.amount; }
    return { expense, income, balance: income - expense };
  }, [household]);

  const byCategory = useMemo(() => {
    const map = {};
    for (const e of household) { if (e.type === "expense") map[e.category] = (map[e.category] || 0) + e.amount; }
    const arr = Object.entries(map).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
    const max = arr.length ? arr[0].amount : 0;
    return { arr, max };
  }, [household]);

  const trend = useMemo(() => {
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(shiftMonth(curMonth(), -i));
    const data = months.map((m) => {
      const exp = entries.filter((e) => e.type === "expense" && !isPersonal(e) && e.category !== "제외" && (e.date || "").startsWith(m)).reduce((s, e) => s + e.amount, 0);
      return { m, exp };
    });
    const max = Math.max(1, ...data.map((d) => d.exp));
    return { data, max };
  }, [entries]);

  // 개인 용돈: 내가 대상인 지출 (RLS로 상대 개인지출은 애초에 안 옴)
  // 용돈 = 내 개인카드(우리카드/IBK, 현욱=카카오뱅크) 흐름 (누구 돈 기준)
  const isMyAllowance = (e) => cardOwner(e) === myPerson && e.category !== "제외";
  const myPersonal = useMemo(() => {
    const list = monthEntries.filter(isMyAllowance);
    const spent = list.filter((e) => e.type === "expense").reduce((s, e) => s + e.amount, 0);
    return { list, spent, remain: ALLOWANCE - spent, pct: Math.min(100, Math.round((spent / ALLOWANCE) * 100)) };
  }, [monthEntries, myPerson]);
  // 용돈 통장 실제 잔고 = 누적 입금(충전) − 지출 (본인 통장만)
  const myBalance = useMemo(() =>
    entries.filter(isMyAllowance).reduce((s, e) => s + (e.type === "income" ? e.amount : -e.amount), 0),
  [entries, myPerson]);

  // [분석] 탭: 이번 달 지출 원본 (차트가 자체 그룹핑)
  const analysis = useMemo(() => {
    const exp = monthEntries.filter((e) => e.type === "expense" && e.category !== "제외");
    return { exp, total: exp.reduce((s, e) => s + e.amount, 0) };
  }, [monthEntries]);

  // [자산] 탭: 계좌별 최신 스냅샷 + 총자산 + 추이
  const asset = useMemo(() => {
    const byAcct = {};
    for (const a of assets) { if (!byAcct[a.account]) byAcct[a.account] = a; } // date desc → 첫 등장이 최신
    const latest = Object.values(byAcct);
    const totalKRW = latest.reduce((s, a) => s + (Number(a.total_eval) || 0) + (Number(a.deposit) || 0), 0);
    const profitKRW = latest.reduce((s, a) => s + (Number(a.profit) || 0), 0);
    const byDate = {};
    for (const a of assets) { byDate[a.date] = (byDate[a.date] || 0) + (Number(a.total_eval) || 0) + (Number(a.deposit) || 0); }
    const trend = Object.entries(byDate).map(([d, v]) => ({ d, v })).sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-7);
    return { latest, totalKRW, profitKRW, trend, max: Math.max(1, ...trend.map((t) => t.v)) };
  }, [assets]);

  // 입력 시트 열려 있을 때: Esc 키로 닫기 + 배경 스크롤 잠금 (접근성·모바일 UX)
  useEffect(() => {
    if (!adding) return;
    const onKey = (e) => { if (e.key === "Escape") { setAdding(false); setEditingId(null); } };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [adding]);

  const cats = form.type === "income" ? INCOME_CATS : EXPENSE_CATS;

  const closeSheet = () => { setAdding(false); setEditingId(null); };

  const openEdit = (e) => {
    setForm({
      date: e.date, type: e.type, amount: String(e.amount), category: e.category,
      item: e.item || "", beneficiary: e.beneficiary || "온가족",
    });
    setEditingId(e.id);
    setAdding(true);
  };

  const submit = async () => {
    const amt = parseInt(String(form.amount).replace(/[^0-9]/g, ""), 10);
    if (!amt || amt <= 0) { alert("금액을 입력해 주세요."); return; }
    setSaving(true);
    const row = {
      date: form.date, type: form.type, amount: amt, category: form.category,
      item: form.item.trim() || null, who: myPerson,
      beneficiary: form.type === "expense" ? form.beneficiary : "온가족",
    };
    const q = editingId
      ? supabase.from("ledger").update(row).eq("id", editingId).select().single()
      : supabase.from("ledger").insert(row).select().single();
    const { data, error } = await q;
    setSaving(false);
    if (error) { alert(editingId ? "수정에 실패했어요. 다시 시도해 주세요." : "저장에 실패했어요. 다시 시도해 주세요."); return; }
    setEntries((prev) => editingId ? prev.map((x) => (x.id === editingId ? data : x)) : [data, ...prev]);
    setForm((f) => ({ ...f, amount: "", item: "" }));
    closeSheet();
    setMonth(form.date.slice(0, 7));
  };

  const remove = async (id) => {
    if (!window.confirm("이 내역을 삭제할까요?")) return;
    setEntries((prev) => prev.filter((e) => e.id !== id));
    await supabase.from("ledger").delete().eq("id", id);
  };

  return (
    <div style={wrap}>
      <style>{`
        @keyframes donutPop { from { opacity:0; transform: rotate(-16deg) scale(.72) } to { opacity:1; transform: none } }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes rowIn { from { opacity:0; transform: translateX(-10px) } to { opacity:1; transform: none } }
      `}</style>
      <header style={head}>
        <div style={{ fontSize: 26 }}>🥬</div>
        <h1 style={h1}>짠지</h1>
        <p style={{ margin: "3px 0 0", color: "#b3a99a", fontSize: 12.5 }}>유찬이네 가계부 · {disp(myPerson)}</p>
        <button style={refreshBtn} onClick={load} title="새로고침" aria-label="새로고침">{loading ? "⏳" : "🔄"}</button>
        <button style={logoutBtn} onClick={() => supabase.auth.signOut()}>로그아웃</button>
      </header>

      {/* 탭 */}
      <div style={tabBar}>
        {[["ledger", "📒 가계부"], ["allowance", "💵 용돈"], ["analysis", "📊 분석"], ["asset", "💎 자산"]].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{ ...tabBtn, ...(tab === t ? tabBtnOn : {}) }}>{label}</button>
        ))}
      </div>

      {/* 월 선택 */}
      <div style={monthBar}>
        <button style={arrow} onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="이전 달">‹</button>
        <span style={{ fontWeight: 800, fontSize: 16 }}>{monthLabel(month)}</span>
        <button style={arrow} onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={month >= curMonth()} aria-label="다음 달">›</button>
      </div>

      {tab === "ledger" && (
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

          {/* 내역 리스트 (공용만) */}
          <section style={card}>
            <h2 style={h2}>공용 내역 <span style={{ color: "#b3a99a", fontSize: 13, fontWeight: 500 }}>{household.length}건</span></h2>
            {loading ? <p style={empty}>불러오는 중…</p> : household.length === 0 ? (
              <p style={empty}>이번 달 공용 내역이 없어요.</p>
            ) : (
              household.map((e) => (
                <div key={e.id} style={{ ...entryRow, cursor: "pointer" }} onClick={() => openEdit(e)} role="button" tabIndex={0}
                  onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openEdit(e); } }}
                  aria-label={`${e.item || e.category} 수정`}>
                  <span style={{ fontSize: 20 }}>{CAT_EMOJI[e.category] || "📦"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>{e.item || e.category}</div>
                    <div style={{ fontSize: 11.5, color: "#b3a99a" }}>
                      {e.date?.slice(5).replace("-", ".")} · {e.category}
                      {e.beneficiary ? ` · ${BEN_EMOJI[e.beneficiary] || ""}${disp(e.beneficiary)}` : ""}
                    </div>
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 800, color: e.type === "income" ? "#3f8f52" : "#4a4438", whiteSpace: "nowrap" }}>
                    {e.type === "income" ? "+" : "-"}{won(e.amount).replace("₩", "")}
                  </span>
                  <button onClick={(ev) => { ev.stopPropagation(); remove(e.id); }} style={delBtn} aria-label={`${e.item || e.category} ${won(e.amount).replace("₩", "")}원 삭제`}>×</button>
                </div>
              ))
            )}
          </section>
        </>
      )}
      {tab === "allowance" && (
        <>
          {/* 용돈 통장 잔고 */}
          <section style={{ ...card, textAlign: "center" }}>
            <div style={{ fontSize: 12.5, color: "#8a8170", fontWeight: 600, marginBottom: 4 }}>💳 {disp(myPerson)} 용돈 통장 잔고</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: myBalance < 0 ? "#d9663f" : "#4a4438" }}>{won(myBalance)}</div>
          </section>

          {/* 이번 달 용돈 사용 */}
          <section style={card}>
            <h2 style={h2}>이번 달 용돈 사용</h2>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: myPersonal.remain < 0 ? "#d9663f" : "#4a4438" }}>{won(myPersonal.spent)}</span>
              <span style={{ fontSize: 13, color: "#8a8170" }}>/ {won(ALLOWANCE)} 예산</span>
            </div>
            <div style={{ ...barTrack, height: 12 }}>
              <div style={{ ...barFill, width: `${myPersonal.pct}%`, background: myPersonal.pct >= 100 ? "#d9663f" : myPersonal.pct >= 80 ? "#e0a04a" : "#63c187" }} />
            </div>
            <p style={{ margin: "10px 2px 0", fontSize: 13, color: myPersonal.remain < 0 ? "#d9663f" : "#8a8170", fontWeight: 600 }}>
              {myPersonal.remain >= 0 ? `예산 ${won(myPersonal.remain)} 남았어요` : `예산을 ${won(-myPersonal.remain)} 초과했어요 😰`}
            </p>
          </section>

          <section style={card}>
            <h2 style={h2}>내 용돈 내역 <span style={{ color: "#b3a99a", fontSize: 13, fontWeight: 500 }}>{myPersonal.list.length}건</span></h2>
            {myPersonal.list.length === 0 ? (
              <p style={empty}>이번 달 용돈 내역이 없어요. 알뜰하시네요! 🥬</p>
            ) : (
              myPersonal.list.map((e) => (
                <div key={e.id} style={{ ...entryRow, cursor: "pointer" }} onClick={() => openEdit(e)} role="button" tabIndex={0}
                  onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openEdit(e); } }}
                  aria-label={`${e.item || e.category} 수정`}>
                  <span style={{ fontSize: 20 }}>{CAT_EMOJI[e.category] || "📦"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>{e.item || e.category}</div>
                    <div style={{ fontSize: 11.5, color: "#b3a99a" }}>{e.date?.slice(5).replace("-", ".")} · {e.category}</div>
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 800, color: e.type === "income" ? "#3f8f52" : "#4a4438", whiteSpace: "nowrap" }}>{e.type === "income" ? "+" : "-"}{won(e.amount).replace("₩", "")}</span>
                  <button onClick={(ev) => { ev.stopPropagation(); remove(e.id); }} style={delBtn} aria-label={`${e.item || e.category} ${won(e.amount).replace("₩", "")}원 삭제`}>×</button>
                </div>
              ))
            )}
          </section>

          <p style={{ ...empty, fontSize: 12 }}>🔒 배우자의 개인 지출은 프라이버시라서 보이지 않아요.</p>
        </>
      )}
      {tab === "analysis" && (
        <>
          <div style={{ ...balanceCard, marginBottom: 14 }}>
            <span style={{ color: "#8a8170", fontSize: 13 }}>이번 달 전체 지출</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: "#4a4438" }}>{won(analysis.total)}</span>
          </div>
          <DonutChart title="💳 카드별 지출" field="card" exp={analysis.exp} />
          <DonutChart title="👤 소비 주체별 (누가 썼나)" field="who" exp={analysis.exp} />
          <DonutChart title="🎯 소비 대상별 (누구 위해)" field="beneficiary" exp={analysis.exp} />
          <p style={{ ...empty, fontSize: 12 }}>💡 항목을 누르면 자세히 볼 수 있어요 · 나에게 보이는 지출 기준</p>
        </>
      )}
      {tab === "asset" && (
        <>
          {asset.latest.length === 0 ? (
            <section style={card}><p style={empty}>아직 자산 스냅샷이 없어요.<br />토스증권 잔고가 매일 자동으로 쌓일 거예요 📈</p></section>
          ) : (
            <>
              <section style={{ ...card, textAlign: "center", background: "linear-gradient(135deg,#4a4438,#6a5f4e)", border: "none", animation: "donutPop .6s cubic-bezier(.34,1.56,.64,1) both" }}>
                <div style={{ fontSize: 12.5, color: "#e6ddd2", marginBottom: 4 }}>💎 총 자산</div>
                <div style={{ fontSize: 30, fontWeight: 800, color: "#fff" }}>{won(asset.totalKRW)}</div>
                <div style={{ fontSize: 13, marginTop: 6, fontWeight: 700, color: asset.profitKRW >= 0 ? "#8fe3ac" : "#ffab8f" }}>
                  평가손익 {asset.profitKRW >= 0 ? "+" : ""}{won(asset.profitKRW)}
                </div>
              </section>
              {asset.trend.length > 1 && (
                <section style={card}>
                  <h2 style={h2}>총자산 추이</h2>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 100, marginTop: 6 }}>
                    {asset.trend.map((t) => (
                      <div key={t.d} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                        <div style={{ fontSize: 9.5, color: "#8a8170" }}>{Math.round(t.v / 10000)}만</div>
                        <div style={{ width: "66%", height: `${(t.v / asset.max) * 70}px`, minHeight: 3, background: "#63c187", borderRadius: 5 }} />
                        <div style={{ fontSize: 10, color: "#b3a99a" }}>{t.d.slice(5)}</div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {asset.latest.map((a) => (
                <section key={a.id} style={card}>
                  <h2 style={h2}>🏦 {a.account} <span style={{ color: "#b3a99a", fontSize: 12, fontWeight: 500 }}>{a.date}</span></h2>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13.5 }}><span style={{ color: "#8a8170" }}>총평가금액</span><span style={{ fontWeight: 800 }}>{won(Number(a.total_eval) || 0)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13.5 }}><span style={{ color: "#8a8170" }}>예수금</span><span style={{ fontWeight: 700 }}>{won(Number(a.deposit) || 0)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13.5 }}><span style={{ color: "#8a8170" }}>평가손익</span><span style={{ fontWeight: 700, color: (Number(a.profit) || 0) >= 0 ? "#3f8f52" : "#d9663f" }}>{(Number(a.profit) || 0) >= 0 ? "+" : ""}{won(Number(a.profit) || 0)}</span></div>
                  {a.fx_rate ? <div style={{ fontSize: 11.5, color: "#b3a99a", marginTop: 6 }}>💵 ${Number(a.total_eval_usd || 0).toLocaleString("en-US")} · 환율 {Number(a.fx_rate).toLocaleString("ko-KR")}원</div> : null}
                  {Array.isArray(a.holdings) && a.holdings.length > 0 && (
                    <div style={{ marginTop: 10, borderTop: "1px solid #f2ebe3", paddingTop: 8 }}>
                      <div style={{ fontSize: 12, color: "#8a8170", fontWeight: 700, marginBottom: 6 }}>보유 종목 {a.holdings.length} <span style={{ fontWeight: 500, color: "#b3a99a" }}>(평가액순)</span></div>
                      {a.holdings
                        .map((h) => ({ ...h, krw: h.currency === "USD" ? Number(h.eval || 0) * Number(a.fx_rate || 0) : Number(h.eval || 0) }))
                        .sort((x, y) => y.krw - x.krw)
                        .slice(0, 10)
                        .map((h, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12.5, padding: "4px 0", borderBottom: "1px solid #f8f4ee" }}>
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name || "종목"}{h.currency === "USD" ? " 🇺🇸" : ""}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, minWidth: 48, textAlign: "right", color: Number(h.rate) >= 0 ? "#3f8f52" : "#d9663f" }}>{Number(h.rate) >= 0 ? "+" : ""}{(Number(h.rate || 0) * 100).toFixed(1)}%</span>
                            <span style={{ fontWeight: 700, minWidth: 76, textAlign: "right" }}>{won(Math.round(h.krw))}</span>
                          </div>
                        ))}
                      {a.holdings.length > 10 && <div style={{ fontSize: 11, color: "#b3a99a", marginTop: 5 }}>+{a.holdings.length - 10}종목 더</div>}
                    </div>
                  )}
                </section>
              ))}
              <p style={{ ...empty, fontSize: 12 }}>📸 매일 07:10 자동 업데이트 · 🔒 로그인한 두 분만 조회</p>
            </>
          )}
        </>
      )}

      {/* 추가 버튼 */}
      <button style={fab} onClick={() => { setEditingId(null); setForm((f) => ({ ...f, date: todayStr(), amount: "", item: "" })); setAdding(true); }} aria-label="거래 추가">+</button>

      {/* 입력 시트 */}
      {adding && (
        <div style={overlay} onClick={closeSheet}>
          <div style={sheet} role="dialog" aria-modal="true" aria-label={editingId ? "내역 수정" : "내역 추가"} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 17, textAlign: "center", marginBottom: 16 }}>{editingId ? "내역 수정" : "내역 추가"}</div>

            <div role="group" aria-label="유형 선택" style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {[["expense", "지출"], ["income", "수입"]].map(([t, label]) => (
                <button key={t} aria-pressed={form.type === t} onClick={() => setForm((f) => ({ ...f, type: t, category: (t === "income" ? INCOME_CATS : EXPENSE_CATS)[0] }))}
                  style={{ ...typeBtn, ...(form.type === t ? (t === "income" ? typeIncomeOn : typeExpenseOn) : {}) }}>{label}</button>
              ))}
            </div>

            <input inputMode="numeric" aria-label="금액" placeholder="금액 (예: 6000)" value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value.replace(/[^0-9]/g, "") }))}
              onKeyDown={(e) => { if (e.key === "Enter" && !saving && form.amount) submit(); }}
              style={{ ...input, fontSize: 20, fontWeight: 800, textAlign: "center" }} autoFocus />
            {form.amount && (
              <div aria-hidden="true" style={{ textAlign: "center", fontSize: 12.5, color: "#8a8170", fontWeight: 700, margin: "-4px 0 8px" }}>
                {Number(form.amount).toLocaleString("ko-KR")}원
              </div>
            )}

            <input aria-label="항목" placeholder="항목 (예: 스타벅스)" value={form.item}
              onChange={(e) => setForm((f) => ({ ...f, item: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter" && !saving && form.amount) submit(); }}
              enterKeyHint="done" style={input} />

            <div style={{ fontSize: 12.5, color: "#8a8170", margin: "6px 2px 6px", fontWeight: 600 }}>카테고리</div>
            <div role="group" aria-label="카테고리 선택" style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 12 }}>
              {cats.map((c) => (
                <button key={c} aria-pressed={form.category === c} onClick={() => setForm((f) => ({ ...f, category: c }))}
                  style={{ ...catChip, ...(form.category === c ? catChipOn : {}) }}>{CAT_EMOJI[c]} {c}</button>
              ))}
            </div>

            {form.type === "expense" && (
              <>
                <div style={{ fontSize: 12.5, color: "#8a8170", margin: "6px 2px 6px", fontWeight: 600 }}>누구를 위해? (대상)</div>
                <div role="group" aria-label="대상 선택" style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 12 }}>
                  {BENEFICIARIES.map((b) => (
                    <button key={b} aria-pressed={form.beneficiary === b} onClick={() => setForm((f) => ({ ...f, beneficiary: b }))}
                      style={{ ...catChip, ...(form.beneficiary === b ? catChipOn : {}) }}>{BEN_EMOJI[b]} {disp(b)}</button>
                  ))}
                </div>
                <p style={{ fontSize: 11.5, color: "#b3a99a", margin: "0 2px 12px" }}>💡 누구를 위해 쓴 돈인지 기록해두는 거예요.</p>
              </>
            )}

            <input type="date" aria-label="날짜" value={form.date} max={todayStr()}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} style={input} />

            <button style={{ ...saveBtn, opacity: (saving || !form.amount) ? 0.6 : 1 }} disabled={saving || !form.amount} onClick={submit}>
              {saving ? (editingId ? "수정 중…" : "저장 중…") : (editingId ? "수정하기" : "저장하기")}
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

// 분석 탭 도넛 차트 (인터랙티브 드릴다운)
const shortWon = (n) => n >= 10000 ? (n / 10000).toFixed(n % 10000 === 0 ? 0 : 1) + "만" : n.toLocaleString("ko-KR");
const FIELD_LABEL = { card: "카드", who: "소비 주체", beneficiary: "소비 대상" };

function groupExp(exp, field) {
  const map = {};
  for (const e of exp) { const k = e[field] || "미지정"; map[k] = (map[k] || 0) + e.amount; }
  const arr = Object.entries(map).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
  return { arr, total: arr.reduce((s, r) => s + r.v, 0) };
}

function MiniBars({ exp, field }) {
  const g = groupExp(exp, field);
  const mx = g.arr.length ? g.arr[0].v : 1;
  return (
    <div style={{ marginTop: 9 }}>
      <div style={{ fontSize: 11.5, color: "#8a8170", fontWeight: 700, margin: "0 0 6px" }}>{FIELD_LABEL[field]}별</div>
      {g.arr.map((r, i) => (
        <div key={r.k} style={{ marginBottom: 7 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
            <span>{emojiFor(r.k)} {disp(r.k)}</span>
            <span style={{ fontWeight: 700 }}>{won(r.v)}</span>
          </div>
          <div style={{ ...barTrack, height: 6 }}>
            <div style={{ ...barFill, width: `${(r.v / mx) * 100}%`, background: CAT_COLOR[i % CAT_COLOR.length] }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ title, field, exp }) {
  const [open, setOpen] = useState(null);
  const data = groupExp(exp, field);
  const total = data.total;
  const others = ["card", "who", "beneficiary"].filter((f) => f !== field);
  const size = 168, sw = 26, R = (size - sw) / 2, cx = size / 2, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <section style={card}>
      <h2 style={{ ...h2, marginBottom: 14 }}>{title}</h2>
      {data.arr.length === 0 ? (
        <p style={empty}>이번 달 내역이 없어요.</p>
      ) : (
        <>
          <div style={{ position: "relative", width: size, height: size, margin: "0 auto 16px", animation: "donutPop .6s cubic-bezier(.34,1.56,.64,1) both" }}>
            <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
              {data.arr.map((r, i) => {
                const dash = (total ? r.v / total : 0) * C;
                const el = (
                  <circle key={r.k} cx={cx} cy={cx} r={R} fill="none"
                    stroke={CAT_COLOR[i % CAT_COLOR.length]} strokeWidth={sw}
                    strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={`${-acc}px`}
                    strokeLinecap={data.arr.length > 1 ? "butt" : "round"}
                    style={{ animation: "fadeIn .6s ease both", animationDelay: `${0.15 + i * 0.1}s` }} />
                );
                acc += dash;
                return el;
              })}
            </svg>
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", animation: "fadeIn .5s ease .45s both" }}>
              <span style={{ fontSize: 11, color: "#b3a99a" }}>합계</span>
              <span style={{ fontSize: 19, fontWeight: 800, color: "#4a4438" }}>{shortWon(total)}</span>
            </div>
          </div>
          {data.arr.map((r, i) => {
            const isOpen = open === r.k;
            const sub = exp.filter((e) => (e[field] || "미지정") === r.k);
            return (
              <div key={r.k} style={{ borderBottom: i < data.arr.length - 1 ? "1px solid #f4efe8" : "none", animation: "rowIn .45s ease both", animationDelay: `${0.3 + i * 0.07}s` }}>
                <div onClick={() => setOpen(isOpen ? null : r.k)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 0", cursor: "pointer" }}>
                  <span style={{ width: 11, height: 11, borderRadius: 4, background: CAT_COLOR[i % CAT_COLOR.length], flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{emojiFor(r.k)} {disp(r.k)}</span>
                  <span style={{ fontSize: 12, color: "#b3a99a", fontWeight: 700, minWidth: 34, textAlign: "right" }}>{total ? Math.round((r.v / total) * 100) : 0}%</span>
                  <span style={{ fontSize: 13.5, fontWeight: 800, minWidth: 70, textAlign: "right" }}>{won(r.v)}</span>
                  <span style={{ fontSize: 10, color: "#c9beb0", display: "inline-block", width: 12, transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .2s" }}>▶</span>
                </div>
                {isOpen && (
                  <div style={{ padding: "0 4px 12px 20px", animation: "fadeIn .3s ease both" }}>
                    {others.map((f) => <MiniBars key={f} exp={sub} field={f} />)}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

// ── 스타일 ──
const wrap = { maxWidth: 520, margin: "0 auto", minHeight: "100vh", background: "#faf7f2", color: "#4a4438", fontFamily: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif', padding: "0 16px 90px", position: "relative" };
const head = { textAlign: "center", padding: "24px 0 8px", position: "relative" };
const h1 = { fontSize: 22, fontWeight: 800, margin: "4px 0 0" };
const logoutBtn = { position: "absolute", top: 20, right: 4, background: "none", border: "none", color: "#b3a99a", fontSize: 12, cursor: "pointer", textDecoration: "underline" };
const refreshBtn = { position: "absolute", top: 16, left: 4, background: "none", border: "none", fontSize: 18, cursor: "pointer", lineHeight: 1 };
const tabBar = { display: "flex", gap: 6, marginBottom: 14 };
const tabBtn = { flex: 1, padding: "9px 0", borderRadius: 11, border: "1px solid #ece3da", background: "#fff", color: "#8a8170", fontSize: 11.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };
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
