import React, { useMemo, useState } from "react";
import { Beef, Scissors, Plus, Check, ChevronRight, ArrowDown, Activity, Boxes, Search, Save } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { C, nairaFmt, kgFmt } from "../lib/theme.js";
import { TraceModal } from "./Operations.jsx";
import { ScaleReader, useScale } from "../lib/scale.jsx";
import { KpiCard, SectionHeader, Btn, StatusPill, Modal, Field, Input, Select, Card, Table, Empty, useBusy } from "../components/ui.jsx";

const STATUSES = ["Active", "Growing", "Ready for Processing", "Ready for Sale", "Sold"];
const BREEDS = { Cattle: ["White Fulani", "Sokoto Gudali", "Red Bororo"], Goat: ["Sahel", "Kano Brown", "Sokoto Red"], Sheep: ["Yankasa", "Balami", "Uda"] };

/* ============================================================ RANCH */
export function RanchView({ data, actions, permit }) {
  const livestock = data.livestock || [];
  const stats = data.ranchStats;
  const [filter, setFilter] = useState("On Ranch");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(25);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [processing, setProcessing] = useState(null);

  const onRanch = livestock.filter((l) => l.status !== "Processed" && l.status !== "Sold");
  const bySpecies = ["Cattle", "Goat", "Sheep"].map((sp) => ({ name: sp, value: onRanch.filter((l) => l.species === sp).length }));
  const colors = [C.burgundy, C.gold, C.charcoal3];
  const filtered = useMemo(() => {
    let list = filter === "All" ? livestock : filter === "On Ranch" ? onRanch : livestock.filter((l) => l.status === filter);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter((l) => l.id.toLowerCase().includes(s) || l.tag.toLowerCase().includes(s) || l.breed.toLowerCase().includes(s));
    }
    return list;
  }, [livestock, filter, q]);

  return (
    <div>
      {selected && (
        <AnimalProfile animal={livestock.find((a) => a.id === selected) || {}} onClose={() => setSelected(null)} actions={actions} permit={permit}
          onProcess={(a) => { setSelected(null); setProcessing(a); }} />
      )}
      {adding && <AddAnimalModal ranches={data.meta.ranches} showCost={permit("costs.view")} onClose={() => setAdding(false)} onSave={actions.addAnimal} />}
      {processing && <ProcessingModal animal={processing} locations={data.meta.locations} onClose={() => setProcessing(null)} onComplete={actions.processBatch} />}

      <SectionHeader eyebrow="Ranch Operations" title="Herd Overview & Livestock"
        action={permit("ranch.edit") && <Btn icon={Plus} small onClick={() => setAdding(true)}>Add Animal</Btn>} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <KpiCard label="Herd on Ranch" value={stats.herd} sub={`across ${stats.ranches} ranches`} icon={Beef} />
        <KpiCard label="Cattle" value={stats.cattle} icon={Beef} />
        <KpiCard label="Goats & Sheep" value={stats.small} icon={Beef} />
        <KpiCard label="Ready for Processing" value={stats.ready} sub="see Processing" icon={Scissors} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
        <Card>
          <h3 className="f-display text-base mb-3" style={{ color: C.ink }}>Herd by Species</h3>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={bySpecies} dataKey="value" nameKey="name" innerRadius={40} outerRadius={65} paddingAngle={3}>
                {bySpecies.map((_, i) => <Cell key={i} fill={colors[i]} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex justify-center gap-4 mt-1">
            {bySpecies.map((s, i) => (
              <div key={s.name} className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: colors[i] }} />
                <span className="f-body text-xs" style={{ color: C.muted }}>{s.name} · {s.value}</span>
              </div>
            ))}
          </div>
        </Card>
        {stats.value !== undefined ? (
          <Card className="lg:col-span-2">
            <h3 className="f-display text-base mb-3" style={{ color: C.ink }}>Herd Value (at cost)</h3>
            <div className="f-mono text-2xl sm:text-3xl font-semibold mb-1 truncate" style={{ color: C.burgundy }}>{nairaFmt(stats.value)}</div>
            <p className="f-body text-xs" style={{ color: stats.uncosted ? C.danger : C.muted }}>
              {stats.uncosted ? `${stats.uncosted} animal${stats.uncosted === 1 ? " has" : "s have"} no purchase cost yet — open each one to record it.` : "Sum of purchase cost for every animal still on the ranch."}
            </p>
          </Card>
        ) : (
          <Card className="lg:col-span-2">
            <h3 className="f-display text-base mb-3" style={{ color: C.ink }}>Health & Vaccination</h3>
            <div className="grid grid-cols-2 gap-3 f-mono text-sm">
              <div><div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Under observation</div><div className="text-xl font-semibold" style={{ color: C.warn }}>{onRanch.filter((l) => l.health !== "Healthy").length}</div></div>
              <div><div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Vaccination not up to date</div><div className="text-xl font-semibold" style={{ color: C.danger }}>{onRanch.filter((l) => l.vaccination !== "Up to date").length}</div></div>
            </div>
          </Card>
        )}
      </div>

      <Card pad={false}>
        <div className="flex flex-col gap-3 px-5 py-4 border-b" style={{ borderColor: C.line }}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h3 className="f-display text-base" style={{ color: C.ink }}>Livestock Register</h3>
            <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 sm:w-64" style={{ background: C.cream }}>
              <Search size={14} style={{ color: C.muted }} />
              <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(25); }} placeholder="Search ID, tag or breed" className="bg-transparent outline-none text-sm f-body w-full" />
            </div>
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {["On Ranch", ...STATUSES.slice(0, 4), "Processed", "All"].map((s) => (
              <button key={s} onClick={() => { setFilter(s); setLimit(25); }} className="f-body text-xs px-2.5 py-1.5 rounded-md font-medium shrink-0 transition-all active:scale-95"
                style={{ background: filter === s ? C.charcoal : C.cream, color: filter === s ? "#fff" : C.muted }}>{s}</button>
            ))}
          </div>
        </div>
        <Table head={["Animal ID", "Species / Breed", "Sex", "Age", "Weight", "Location", "Health", "Status", ""]} minWidth={900}
          empty={filtered.length === 0 ? "No animals match." : null}>
          {filtered.slice(0, limit).map((a) => (
            <tr key={a.id} className="border-t hover:bg-stone-50 cursor-pointer transition-colors" style={{ borderColor: C.rowLine }} onClick={() => setSelected(a.id)}>
              <td className="px-5 py-3 f-mono text-sm font-semibold" style={{ color: C.burgundy }}>{a.id}</td>
              <td className="px-5 py-3 f-body text-sm" style={{ color: C.ink }}>{a.species} · {a.breed}</td>
              <td className="px-5 py-3 f-body text-sm" style={{ color: C.muted }}>{a.sex}</td>
              <td className="px-5 py-3 f-body text-sm" style={{ color: C.muted }}>{a.age}</td>
              <td className="px-5 py-3 f-mono text-sm" style={{ color: C.ink }}>{a.weight} KG</td>
              <td className="px-5 py-3 f-body text-sm" style={{ color: C.muted }}>{a.location}</td>
              <td className="px-5 py-3"><StatusPill status={a.health} /></td>
              <td className="px-5 py-3"><StatusPill status={a.status} /></td>
              <td className="px-5 py-3"><ChevronRight size={15} style={{ color: C.muted }} /></td>
            </tr>
          ))}
        </Table>
        {filtered.length > limit && (
          <div className="px-5 py-3 border-t flex items-center justify-between" style={{ borderColor: C.line }}>
            <span className="f-body text-xs" style={{ color: C.muted }}>Showing {limit} of {filtered.length}</span>
            <Btn small variant="ghost" onClick={() => setLimit((l) => l + 50)}>Show more</Btn>
          </div>
        )}
      </Card>
    </div>
  );
}

function AnimalProfile({ animal, onClose, actions, permit, onProcess }) {
  const editable = permit("ranch.edit") && animal.status !== "Processed";
  const showCost = animal.acquisitionCost !== undefined;
  const [form, setForm] = useState({ status: animal.status, weight: String(animal.weight), health: animal.health, vaccination: animal.vaccination, pen: animal.pen, cost: animal.acquisitionCost == null ? "" : String(animal.acquisitionCost) });
  const [busy, run] = useBusy();
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));
  const dirty = form.status !== animal.status || Number(form.weight) !== animal.weight || form.health !== animal.health || form.vaccination !== animal.vaccination || form.pen !== animal.pen
    || (showCost && form.cost !== "" && Number(form.cost) !== animal.acquisitionCost);
  const save = () => run(async () => {
    const body = {};
    if (form.status !== animal.status) body.status = form.status;
    if (Number(form.weight) !== animal.weight) body.weight = Number(form.weight);
    if (form.health !== animal.health) body.health = form.health;
    if (form.vaccination !== animal.vaccination) body.vaccination = form.vaccination;
    if (form.pen !== animal.pen) body.pen = form.pen;
    if (showCost && form.cost !== "" && Number(form.cost) !== animal.acquisitionCost) body.cost = Number(form.cost);
    if (await actions.updateAnimal(animal.id, body)) onClose();
  });

  return (
    <Modal title={animal.id} onClose={onClose} wide>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="sm:col-span-2">
          <div className="flex items-center gap-2 mb-4"><StatusPill status={animal.status} /><StatusPill status={animal.health} /></div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {[["Tag Number", animal.tag], ["Species", animal.species], ["Breed", animal.breed], ["Sex", animal.sex], ["Age", animal.age],
              ["Weight", `${animal.weight} KG`], ["Location", animal.location], ["Pen", animal.pen], ["Acquired", animal.acquisitionDate]].map(([l, v]) => (
              <div key={l}>
                <div className="f-body text-[10px] uppercase tracking-wide" style={{ color: C.muted }}>{l}</div>
                <div className="f-mono text-sm font-medium" style={{ color: C.ink }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl p-4" style={{ background: C.cream }}>
          {animal.acquisitionCost !== undefined && (<>
            <div className="f-body text-[10px] uppercase tracking-wide mb-1" style={{ color: C.muted }}>Purchase Cost</div>
            <div className="f-mono text-xl font-semibold mb-3" style={{ color: animal.acquisitionCost == null ? C.danger : C.burgundy }}>{animal.acquisitionCost == null ? "Not recorded" : nairaFmt(animal.acquisitionCost)}</div>
          </>)}
          <div className="f-body text-[10px] uppercase tracking-wide mb-1" style={{ color: C.muted }}>Vaccination</div>
          <div className="f-body text-sm" style={{ color: C.ink }}>{animal.vaccination}</div>
        </div>
      </div>

      {editable && (
        <div className="rounded-xl border p-4 mb-5" style={{ borderColor: C.border }}>
          <h4 className="f-body text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: C.muted }}>Update Record</h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            <Field label="Status"><Select value={form.status} onChange={set("status")}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <Field label="Weight (KG)"><Input mono type="number" step="0.1" min="1" value={form.weight} onChange={set("weight")} /></Field>
            <Field label="Health"><Select value={form.health} onChange={set("health")}><option>Healthy</option><option>Under Observation</option></Select></Field>
            <Field label="Vaccination"><Select value={form.vaccination} onChange={set("vaccination")}><option>Up to date</option><option>Pending</option><option>Overdue</option></Select></Field>
            <Field label="Pen"><Input value={form.pen} onChange={set("pen")} maxLength={30} /></Field>
            {showCost && <Field label="Purchase cost (₦)"><Input mono type="number" min="0" step="1" value={form.cost} onChange={set("cost")} placeholder="Not recorded" /></Field>}
          </div>
          <Btn icon={Save} small busy={busy} disabled={!dirty || !(Number(form.weight) > 0)} onClick={save}>Save Changes</Btn>
        </div>
      )}

      {animal.status === "Ready for Processing" && permit("processing.edit") && (
        <Btn icon={Scissors} onClick={() => onProcess(animal)}>Create Processing Batch</Btn>
      )}
    </Modal>
  );
}

function AddAnimalModal({ ranches, showCost, onClose, onSave }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ species: "Cattle", breed: "White Fulani", sex: "Male", age: "1.5", weight: "280", cost: "", ranch: ranches[0], health: "Healthy", pen: "Pen 01", acquiredOn: today });
  const [busy, run] = useBusy();
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value, ...(k === "species" ? { breed: BREEDS[e.target.value][0] } : {}) }));
  const valid = Number(form.weight) > 0 && (form.cost === "" || (Number.isInteger(Number(form.cost)) && Number(form.cost) >= 0)) && Number(form.age) >= 0 && form.breed.trim();
  const save = () => run(async () => {
    const { cost, ...rest } = form;
    const r = await onSave({ ...rest, age: Number(form.age), weight: Number(form.weight), ...(showCost && cost !== "" ? { cost: Number(cost) } : {}) });
    if (r) onClose();
  });
  return (
    <Modal title="Add Animal" onClose={onClose}>
      <div className="grid grid-cols-2 gap-4 mb-5">
        <Field label="Species"><Select value={form.species} onChange={set("species")}><option>Cattle</option><option>Goat</option><option>Sheep</option></Select></Field>
        <Field label="Breed">
          <Input list="breeds" value={form.breed} onChange={set("breed")} maxLength={60} />
          <datalist id="breeds">{BREEDS[form.species].map((b) => <option key={b} value={b} />)}</datalist>
        </Field>
        <Field label="Sex"><Select value={form.sex} onChange={set("sex")}><option>Male</option><option>Female</option></Select></Field>
        <Field label="Age (years)"><Input mono type="number" step="0.1" min="0" value={form.age} onChange={set("age")} /></Field>
        <Field label="Weight (KG)"><Input mono type="number" min="1" value={form.weight} onChange={set("weight")} /></Field>
        {showCost && <Field label="Purchase cost (₦)" hint="Leave blank if not known yet"><Input mono type="number" min="0" step="1" value={form.cost} onChange={set("cost")} /></Field>}
        <Field label="Ranch"><Select value={form.ranch} onChange={set("ranch")}>{ranches.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        <Field label="Pen"><Input value={form.pen} onChange={set("pen")} maxLength={30} /></Field>
        <Field label="Health"><Select value={form.health} onChange={set("health")}><option>Healthy</option><option>Under Observation</option></Select></Field>
        <Field label="Acquired On"><Input type="date" max={today} value={form.acquiredOn} onChange={set("acquiredOn")} /></Field>
      </div>
      <Btn icon={Check} disabled={!valid} busy={busy} onClick={save} full>Add to Livestock Register</Btn>
    </Modal>
  );
}

/* ============================================================ PROCESSING */
export function ProcessingView({ data, actions, permit }) {
  const ready = (data.livestock || []).filter((l) => l.status === "Ready for Processing");
  const { log, stats } = data.processing;
  const [batchFor, setBatchFor] = useState(null);
  const [tracing, setTracing] = useState(null);
  return (
    <div>
      {tracing && <TraceModal lot={tracing} actions={actions} onClose={() => setTracing(null)} />}
      {batchFor && <ProcessingModal animal={batchFor} locations={data.meta.locations} onClose={() => setBatchFor(null)} onComplete={actions.processBatch} />}
      <SectionHeader eyebrow="Processing" title="Processing Batches & Yield" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <KpiCard label="Batches This Month" value={stats.batchesMtd} icon={Scissors} />
        <KpiCard label="Avg. Yield (30 days)" value={stats.avgYield != null ? `${stats.avgYield}%` : "—"} icon={Activity} />
        <KpiCard label="Ready to Process" value={ready.length} sub="animals flagged" icon={Beef} />
        <KpiCard label="Saleable KG (MTD)" value={kgFmt(stats.kgMtd)} icon={Boxes} />
      </div>

      <Card className="mb-6">
        <h3 className="f-display text-base mb-3" style={{ color: C.ink }}>Ready for Processing</h3>
        {ready.length === 0 ? (
          <Empty>No animals are flagged. Set an animal's status to "Ready for Processing" from the Livestock register.</Empty>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ready.map((a) => (
              <div key={a.id} className="rounded-xl p-4 flex items-center justify-between gap-2" style={{ background: C.cream }}>
                <div className="min-w-0">
                  <div className="f-mono text-sm font-semibold" style={{ color: C.burgundy }}>{a.id}</div>
                  <div className="f-body text-xs" style={{ color: C.muted }}>{a.species} · {a.breed} · {a.weight} KG</div>
                </div>
                {permit("processing.edit") && <Btn small onClick={() => setBatchFor(a)}>Process</Btn>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card pad={false}>
        <div className="px-5 py-4 border-b f-display text-base" style={{ borderColor: C.line, color: C.ink }}>Batch History</div>
        <Table head={["Batch ID", "Animal", "Live Weight", "Saleable Meat", "Yield", "Date", ""]} minWidth={640} empty={log.length === 0 ? "No batches yet." : null}>
          {log.map((p) => (
            <tr key={p.id} className="border-t" style={{ borderColor: C.rowLine }}>
              <td className="px-5 py-3 f-mono text-sm font-semibold" style={{ color: C.burgundy }}>{p.id}</td>
              <td className="px-5 py-3 f-mono text-sm" style={{ color: C.ink }}>{p.animal} <span className="f-body text-xs" style={{ color: C.muted }}>· {p.species}</span></td>
              <td className="px-5 py-3 f-mono text-sm" style={{ color: C.ink }}>{p.live} KG</td>
              <td className="px-5 py-3 f-mono text-sm" style={{ color: C.ink }}>{p.saleable} KG</td>
              <td className="px-5 py-3"><span className="f-mono text-sm font-semibold" style={{ color: p.yield >= (p.species === "Cattle" ? 68 : 62) ? C.ok : C.warn }}>{p.yield}%</span></td>
              <td className="px-5 py-3 f-body text-sm" style={{ color: C.muted }}>{p.date}</td>
              <td className="px-5 py-3 text-right">{permit("trace.view") && <Btn small variant="ghost" icon={Search} onClick={() => setTracing(p.id)}>Trace</Btn>}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

/** Starting values scaled to this animal's live weight — staff then enter what the scale says. */
function defaultOutputs(animal) {
  const w = animal.weight;
  const r = (x) => Math.round(w * x * 10) / 10;
  return animal.species === "Cattle"
    ? { premium: r(0.22), stew: r(0.2), boneless: r(0.12), minced: r(0.09), other: r(0.07), bones: r(0.12), offal: r(0.06), fat: r(0.045), kpomo: r(0.03), waste: r(0.03) }
    : { premium: r(0.34), stew: r(0.28), boneless: 0, minced: 0, other: 0, bones: r(0.14), offal: r(0.08), fat: r(0.03), kpomo: r(0.02), waste: r(0.03) };
}

function ProcessingModal({ animal, locations, onClose, onComplete }) {
  const isCattle = animal.species === "Cattle";
  const [v, setV] = useState(() => defaultOutputs(animal));
  const [location, setLocation] = useState(locations.includes("Cold Room A") ? "Cold Room A" : locations[0]);
  const [busy, run] = useBusy();
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: Math.max(0, Number(e.target.value) || 0) }));
  const round = (n) => Math.round(n * 100) / 100;
  const saleable = round(v.premium + v.stew + v.boneless + v.minced + v.other);
  const byproducts = round(v.bones + v.offal + v.fat + v.kpomo);
  const total = round(saleable + byproducts + v.waste);
  const unaccounted = round(animal.weight - total);
  const over = total > animal.weight;
  const yieldPct = (saleable / animal.weight) * 100;

  const fields = isCattle
    ? [["premium", "Premium Cuts"], ["stew", "Stew Cuts"], ["boneless", "Boneless"], ["minced", "Minced"], ["other", "Other Cuts"]]
    : [["premium", "Prime Cuts"], ["stew", "Stew Cuts"]];
  const byFields = [["bones", "Bones"], ["offal", "Offal"], ["fat", "Fat"], ["kpomo", "Kpomo"], ["waste", "Waste"]];
  const scale = useScale();
  const [weighInto, setWeighInto] = useState("premium");
  const [weighed, setWeighed] = useState([]); // log of trays weighed on the scale

  const complete = () => run(async () => {
    const r = await onComplete({ animal: animal.id, location, outputs: v });
    if (r) onClose();
  });

  return (
    <Modal title={`Processing Batch — ${animal.id}`} onClose={onClose} wide>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="rounded-xl p-3" style={{ background: C.cream }}>
          <div className="f-body text-[10px] uppercase" style={{ color: C.muted }}>Live Weight</div>
          <div className="f-mono text-lg font-semibold" style={{ color: C.ink }}>{animal.weight} KG</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: "#F3E4E6" }}>
          <div className="f-body text-[10px] uppercase" style={{ color: C.burgundy }}>Yield</div>
          <div className="f-mono text-lg font-semibold" style={{ color: C.burgundy }}>{yieldPct.toFixed(1)}%</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: over ? "#F5E4E2" : C.cream }}>
          <div className="f-body text-[10px] uppercase" style={{ color: over ? C.danger : C.muted }}>{over ? "Over by" : "Unaccounted"}</div>
          <div className="f-mono text-lg font-semibold" style={{ color: over ? C.danger : C.ink }}>{Math.abs(unaccounted)} KG</div>
        </div>
        <Field label="Store output in">
          <Select value={location} onChange={(e) => setLocation(e.target.value)}>{locations.map((l) => <option key={l}>{l}</option>)}</Select>
        </Field>
      </div>

      {scale?.supported && (
        <div className="rounded-xl p-3 mb-5" style={{ background: C.cream }}>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Weigh each tray into">
              <Select value={weighInto} onChange={(e) => setWeighInto(e.target.value)}>{[...fields, ...byFields].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            </Field>
            <div className="flex-1 min-w-0">
              <ScaleReader label={`Add to ${[...fields, ...byFields].find(([k]) => k === weighInto)[1]}`}
                onWeight={(kg) => { setV((p) => ({ ...p, [weighInto]: round(Number(p[weighInto] || 0) + kg) })); setWeighed((w) => [...w, `${kg} kg → ${[...fields, ...byFields].find(([k]) => k === weighInto)[1]}`]); }} />
            </div>
          </div>
          {weighed.length > 0 && <p className="f-body text-[11px] mt-2" style={{ color: C.muted }}>Weighed: {weighed.slice(-6).join(" · ")}{weighed.length > 6 ? ` (+${weighed.length - 6} more)` : ""}</p>}
        </div>
      )}

      <h4 className="f-body text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: C.muted }}>
        Saleable Meat (KG){!isCattle && ` — stocked as ${animal.species === "Goat" ? "Goat Meat" : "Ram Meat"}`}
      </h4>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 mb-5">
        {fields.map(([k, l]) => (
          <Field key={k} label={l}><Input mono type="number" min="0" step="0.1" value={v[k]} onChange={set(k)} /></Field>
        ))}
      </div>

      <h4 className="f-body text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: C.muted }}>By-products & Waste (KG)</h4>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 mb-6">
        {byFields.map(([k, l]) => (
          <Field key={k} label={l}><Input mono type="number" min="0" step="0.1" value={v[k]} onChange={set(k)} /></Field>
        ))}
      </div>

      <div className="rounded-2xl p-4 sm:p-6 mb-6 overflow-hidden" style={{ background: C.charcoal }}>
        <div className="f-body text-[10px] uppercase tracking-widest mb-4 text-center" style={{ color: C.goldLight }}>Cutting Chart — Where Every Kilogram Goes</div>
        <div className="flex flex-col items-center">
          <FlowNode label="LIVE ANIMAL" value={`${animal.weight} KG`} color={C.cream} />
          <FlowArrow />
          <FlowNode label="SALEABLE MEAT" value={`${saleable} KG`} color={C.goldLight} />
          <FlowArrow />
          <div className="flex gap-2 flex-wrap justify-center mb-3">
            {fields.map(([k, l]) => v[k] > 0 && (
              <div key={k} className="rounded-lg px-3 py-2 text-center" style={{ background: C.charcoal2, border: `1px solid ${C.charcoal3}` }}>
                <div className="f-body text-[9px] uppercase" style={{ color: C.mutedLight }}>{l}</div>
                <div className="f-mono text-sm font-semibold" style={{ color: C.cream }}>{v[k]} KG</div>
              </div>
            ))}
          </div>
          <FlowArrow />
          <div className="flex gap-6">
            <FlowNode label="BY-PRODUCTS" value={`${byproducts} KG`} color={C.mutedLight} small />
            <FlowNode label="WASTE" value={`${v.waste} KG`} color={C.burgundyLight} small />
          </div>
        </div>
      </div>

      {over && <p className="f-body text-xs mb-3" style={{ color: C.danger }}>The outputs add up to {total} KG — more than the {animal.weight} KG live weight. Check the scale readings.</p>}
      <Btn icon={Check} busy={busy} disabled={over || saleable <= 0} onClick={complete}>Complete Batch & Update Inventory</Btn>
    </Modal>
  );
}

function FlowNode({ label, value, color, small }) {
  return (
    <div className="text-center">
      <div className="f-body uppercase tracking-widest" style={{ color: C.mutedLight, fontSize: 9 }}>{label}</div>
      <div className={`f-mono font-semibold ${small ? "text-base" : "text-2xl"}`} style={{ color }}>{value}</div>
    </div>
  );
}
const FlowArrow = () => <ArrowDown size={16} style={{ color: C.goldLight, margin: "6px 0" }} />;
