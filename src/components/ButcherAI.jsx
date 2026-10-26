import React, { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { C } from "../lib/theme.js";

/** Answers are computed on the server from live data each time the state refreshes. */
export default function ButcherAI({ insights, onClose }) {
  const [msgs, setMsgs] = useState([{ role: "ai", text: "Hi, I'm ButcherAI. Pick a question — I answer from your live sales, stock, yield and customer data." }]);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);
  const ask = (i) => setMsgs((m) => [...m, { role: "user", text: insights[i].q }, { role: "ai", text: insights[i].a }]);
  return (
    <div className="fixed bottom-0 right-0 sm:right-6 z-[60] w-full sm:w-96 rounded-t-2xl shadow-2xl flex flex-col" style={{ background: "#fff", maxHeight: "70vh" }}>
      <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 rounded-t-2xl" style={{ background: C.charcoal }}>
        <span className="f-display text-sm flex items-center gap-2" style={{ color: C.cream }}><Sparkles size={14} style={{ color: C.gold }} /> ButcherAI</span>
        <button onClick={onClose} aria-label="Close ButcherAI" className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 active:scale-95 transition-all"><X size={15} color={C.cream} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
        {msgs.map((m, i) => (
          <div key={i} className={`f-body text-sm rounded-xl px-3.5 py-2.5 max-w-[85%] ${m.role === "user" ? "ml-auto" : ""}`}
            style={{ background: m.role === "user" ? C.burgundy : C.cream, color: m.role === "user" ? "#fff" : C.ink }}>
            {m.text}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="p-3 border-t flex flex-wrap gap-1.5 max-h-32 overflow-y-auto" style={{ borderColor: C.line }}>
        {insights.map((x, i) => (
          <button key={i} onClick={() => ask(i)} className="f-body text-[11px] px-2.5 py-1.5 rounded-full transition-all hover:opacity-80 active:scale-95 text-left" style={{ background: C.cream, color: C.ink }}>{x.q}</button>
        ))}
      </div>
    </div>
  );
}
