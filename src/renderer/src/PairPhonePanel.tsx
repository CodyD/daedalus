import { useEffect, useRef, useState } from "react";
import type { LinkedPhone } from "../../main/api-client";
import { announce } from "./a11y";
import { api } from "./api";

interface Props {
  onDone: () => void;
}

/** How often the paired-phone list is checked while the code is showing, to notice the phone pairing. */
const POLL_MS = 3000;

/**
 * Pairs the Daedalus inventory scanner app: shows a one-time code as a QR the
 * phone scans, and lists the phones already paired so they can be removed.
 */
export function PairPhonePanel({ onDone }: Props) {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; qrSvg: string } | null>(null);
  const [phones, setPhones] = useState<LinkedPhone[]>([]);
  /** Phone ids seen so far; null until the first listing. */
  const known = useRef<Set<string> | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  /** Label of the phone that just redeemed the code. */
  const [paired, setPaired] = useState<string | null>(null);

  const fail = (e: unknown) => setError((e as Error).message);
  const newCode = () => {
    setError("");
    setPaired(null);
    api().startPairing().then((p) => { setNow(Date.now()); setPairing(p); }, fail);
  };
  const refresh = () => api().linkedPhones().then((list) => {
    const added = known.current && list.find((p) => !known.current!.has(p.id));
    if (added) {
      announce(`Paired with ${added.label}`);
      setPaired(added.label);
      setPairing(null);
    }
    known.current = new Set(list.map((p) => p.id));
    setPhones(list);
  }, fail);

  useEffect(() => { newCode(); refresh(); }, []);
  const expired = !!pairing && Date.parse(pairing.expiresAt) <= now;
  useEffect(() => {
    if (!pairing || expired) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(refresh, POLL_MS);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [pairing, expired]);

  const unpair = async (p: LinkedPhone) => {
    if (!confirm(`Unpair "${p.label}"? It will no longer be able to add parts to this inventory.`)) return;
    try {
      await api().unpairPhone(p.id);
      setPhones((list) => list.filter((q) => q.id !== p.id));
    } catch (e) {
      fail(e);
    }
  };

  const left = pairing ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;

  return (
    <div className="pair-phone">
      <div className="pair-code">
        {pairing && !expired ? (
          <>
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`} width={200} height={200}
              alt={`Pairing QR code. Or type the code ${pairing.code}`} />
            <div>
              <p>In the <b>Daedalus Inventory Scanner</b> app on your phone, tap <b>Pair</b> and scan this code.</p>
              <p className="desc">Or type it in: <code className="pair-text">{pairing.code}</code></p>
              <p className="desc" aria-live="off">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}. It works once.</p>
            </div>
          </>
        ) : (
          <div>
            <p className="sub">{paired ? `Paired with ${paired}. Parts it adds go into this computer's inventory.` : expired ? "The code expired." : "Getting a code…"}</p>
            {(paired || expired) && <button className="btn" onClick={newCode}>{paired ? "Pair Another Phone" : "New Code"}</button>}
          </div>
        )}
      </div>

      <h3>Paired phones</h3>
      {phones.length === 0 ? <p className="sub">None yet.</p> : (
        <table className="pin-table">
          <thead><tr><th>Phone</th><th>Paired</th><th>Last used</th><th><span className="sr-only">Unpair</span></th></tr></thead>
          <tbody>
            {phones.map((p) => (
              <tr key={p.id}>
                <td>{p.label}</td>
                <td>{new Date(p.createdAt).toLocaleString()}</td>
                <td>{new Date(p.lastSeen).toLocaleString()}</td>
                <td><button className="btn" onClick={() => unpair(p)}>Unpair</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p className="msg-err" role="alert">{error}</p>}
      <div className="actions">
        <div className="spacer" />
        <button className="btn primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
