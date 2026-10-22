// abVerdict.mjs -- the pure A/B verdict with a minimum-effect floor (PLAN-xfasttrie G1, A4, A5).
// tierVerdict (test/witness.mjs) is NOT touched; the effect floor lives only here.
const P = '[lite-loglogn] abVerdict';
const KEYS = Object.freeze(['K', 'need', 'floor', 'scenarios', 'aa', 'control', 'drift', 'load1', 'cores']);
const SC_KEYS = Object.freeze(['name', 'wins', 'losses', 'ratio']);
const CT_KEYS = Object.freeze(['wins', 'losses', 'ratio']);

/** Default minimum effect: a 2% median shift. */
export const AB_EFFECT_FLOOR = 0.02;

function vObj(v, name) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(P + ': ' + name + ' must be an object');
}
function vInt(v, name, lo, hi) {
    if (typeof v !== 'number') throw new TypeError(P + ': ' + name + ' must be a number');
    if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(P + ': ' + name + ' must be an integer in [' + lo + ', ' + hi + ']');
    return v;
}
// own keys only: every listed key REQUIRED as an own property; any other own key is an error
function vKeys(o, name, keys) {
    for (const k of keys) {
        if (!Object.hasOwn(o, k)) throw new TypeError(P + ': ' + name + '.' + k + ' must be an own property (missing or inherited)');
    }
    for (const k of Reflect.ownKeys(o)) {
        if (typeof k === 'string' && keys.includes(k)) continue;
        throw new TypeError(P + ': ' + name + ' has an unknown key ' + (typeof k === 'string' ? JSON.stringify(k) : String(k)) +
            ' (known: ' + keys.join(', ') + ')');
    }
}
function vTally(t, name, K, keys) {
    vObj(t, name);
    vKeys(t, name, keys);
    const wins = vInt(t.wins, name + '.wins', 0, K);
    const losses = vInt(t.losses, name + '.losses', 0, K);
    if (wins + losses > K) throw new RangeError(P + ': ' + name + ' wins + losses > K');
    const ratio = t.ratio;
    if (typeof ratio !== 'number') throw new TypeError(P + ': ' + name + '.ratio must be a number');
    if (!Number.isFinite(ratio) || !(ratio > 0)) throw new RangeError(P + ': ' + name + '.ratio must be finite and > 0');
    return { wins, losses, ratio };
}

/**
 * Pure A/B decision. ratio = medianB / medianA. Own keys only; TypeError / RangeError
 * with the '[lite-loglogn] abVerdict' prefix on any bad input (never an exit code).
 * Per scenario: 'win' iff wins >= need && 1 - ratio >= floor; 'lose' iff losses >= need
 * && ratio - 1 >= floor; else 'none'.
 * Exit precedence (as tierVerdict: first match sets exit, reasons list ALL):
 * 2 PENDING (load1 > 0.5 x cores; drift; any A/A with wins or losses >= need AND
 * |ratio - 1| >= floor), then 1 FAIL (control must 'lose', else the gate has no teeth),
 * else 0 PASS. An A/A reaching need below the floor is NOT flagged.
 * @param {{K:number,need:number,floor:number,scenarios:Array,aa:Array,control:object,drift:boolean,load1:number,cores:number}} input
 * @returns {{exit:0|1|2, reasons:string[], decision:'PASS'|'FAIL'|'PENDING', verdicts:{name:string,verdict:string}[]}}
 */
export function abVerdict(input) {
    vObj(input, 'input');
    vKeys(input, 'input', KEYS);
    const K = vInt(input.K, 'K', 1, Number.MAX_SAFE_INTEGER);
    const need = vInt(input.need, 'need', 1, Number.MAX_SAFE_INTEGER);
    if (!(need * 2 > K) || need > K) throw new RangeError(P + ': need must satisfy K/2 < need <= K');
    const floor = input.floor;
    if (typeof floor !== 'number') throw new TypeError(P + ': floor must be a number');
    if (!Number.isFinite(floor) || !(floor >= 0 && floor < 0.5)) throw new RangeError(P + ': floor must be finite in [0, 0.5)');
    const arr = (a, name) => {
        if (!Array.isArray(a)) throw new TypeError(P + ': ' + name + ' must be an array');
        if (a.length < 1) throw new RangeError(P + ': ' + name + ' must not be empty');
    };
    arr(input.scenarios, 'scenarios');
    arr(input.aa, 'aa');
    const sc = [];
    for (let i = 0; i < input.scenarios.length; i++) {
        const p = input.scenarios[i];
        const nm = 'scenarios[' + i + ']';
        vObj(p, nm);
        vKeys(p, nm, SC_KEYS);
        if (typeof p.name !== 'string') throw new TypeError(P + ': ' + nm + '.name must be a string');
        const t = vTally(p, nm, K, SC_KEYS);
        t.name = p.name;
        sc.push(t);
    }
    const aa = [];
    for (let i = 0; i < input.aa.length; i++) {
        const p = input.aa[i];
        const nm = 'aa[' + i + ']';
        vObj(p, nm);
        vKeys(p, nm, SC_KEYS);
        if (typeof p.name !== 'string') throw new TypeError(P + ': ' + nm + '.name must be a string');
        const t = vTally(p, nm, K, SC_KEYS);
        t.name = p.name;
        aa.push(t);
    }
    const control = vTally(input.control, 'control', K, CT_KEYS);
    if (typeof input.drift !== 'boolean') throw new TypeError(P + ': drift must be a boolean');
    const load1 = input.load1;
    if (typeof load1 !== 'number') throw new TypeError(P + ': load1 must be a number');
    if (!Number.isFinite(load1) || load1 < 0) throw new RangeError(P + ': load1 must be finite and >= 0');
    const cores = vInt(input.cores, 'cores', 1, Number.MAX_SAFE_INTEGER);

    const verdicts = sc.map((t) => ({
        name: t.name,
        verdict: t.wins >= need && 1 - t.ratio >= floor ? 'win' : t.losses >= need && t.ratio - 1 >= floor ? 'lose' : 'none',
    }));
    const reasons = [];
    let exit = -1;
    const hit = (code, why) => { reasons.push(why); if (exit === -1) exit = code; };
    if (load1 > 0.5 * cores) hit(2, 'load: load1 ' + load1 + ' > 0.5 x ' + cores + ' cores (host busy; inconclusive)');
    if (input.drift) hit(2, 'drift: host drift detected in the probe series (inconclusive)');
    for (const t of aa) {
        if ((t.wins >= need || t.losses >= need) && Math.abs(t.ratio - 1) >= floor) {
            hit(2, 'aa: ' + t.name + ' A/A declared a winner (wins ' + t.wins + ', losses ' + t.losses + ' of K ' + K +
                ', need ' + need + ', ratio ' + t.ratio + ' vs floor ' + floor + '; inconclusive)');
        }
    }
    if (!(control.losses >= need && control.ratio - 1 >= floor)) {
        hit(1, 'control: the double-work candidate did not lose (losses ' + control.losses + ', need ' + need +
            ', ratio ' + control.ratio + ', floor ' + floor + ') -- the gate has no teeth');
    }
    if (exit === -1) exit = 0;
    return { exit, reasons, decision: exit === 2 ? 'PENDING' : exit === 1 ? 'FAIL' : 'PASS', verdicts };
}
