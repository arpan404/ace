/**
 * An interactive learning page an agent published with ace_html_render: a binary search
 * explainer with a target slider, a step-through and a quick check. It uses only the theme
 * variables ace passes in, so it follows every theme and mode.
 */
export const explainerHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Binary search, step by step</title>
<style>
  :root { --cell: 34px; }
  body { font: 14px/1.5 var(--font-sans); color: var(--foreground); }
  h2 { font-size: 15px; margin: 0 0 2px; font-weight: 600; }
  p { margin: 0; }
  .lede { color: var(--muted-foreground); margin-bottom: 14px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin-bottom: 12px; }
  label { color: var(--muted-foreground); font-size: 13px; }
  input[type=range] { accent-color: var(--accent); width: min(260px, 100%); }
  .target { font: 600 13px var(--font-mono); padding: 1px 8px; border-radius: 999px; background: var(--muted); }
  .cells { display: grid; grid-template-columns: repeat(16, minmax(0, 1fr)); gap: 4px; margin: 6px 0 4px; }
  .cell { height: var(--cell); display: grid; place-items: center; border-radius: calc(var(--radius) - 4px);
    font: 12px var(--font-mono); border: 1px solid var(--border); color: var(--foreground);
    transition: background-color .18s, opacity .18s, border-color .18s; }
  .cell.out { opacity: .28; }
  .cell.mid { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 22%, transparent); font-weight: 600; }
  .cell.found { border-color: var(--success); background: color-mix(in srgb, var(--success) 26%, transparent); font-weight: 600; }
  .marks { display: grid; grid-template-columns: repeat(16, minmax(0, 1fr)); gap: 4px; height: 16px;
    font: 10px var(--font-mono); color: var(--muted-foreground); text-align: center; }
  .note { min-height: 44px; padding: 10px 12px; border-radius: var(--radius); background: var(--muted); margin: 10px 0 12px; }
  .note b { font-weight: 600; }
  button { font: inherit; font-size: 13px; color: var(--foreground); background: transparent; border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px); padding: 4px 12px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--muted); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--primary); color: var(--primary-foreground); border-color: transparent; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .counter { color: var(--muted-foreground); font-size: 13px; margin-left: auto; font-variant-numeric: tabular-nums; }
  .compare { display: grid; grid-template-columns: 92px 1fr 34px; gap: 6px 10px; align-items: center; font-size: 13px; margin-top: 4px; }
  .bar { height: 8px; border-radius: 999px; background: var(--chart-1); transition: width .25s; }
  .bar.linear { background: var(--chart-2); }
  .num { font: 12px var(--font-mono); color: var(--muted-foreground); text-align: right; }
  .quiz { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 12px; }
  .choices { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .choices button[aria-pressed=true].right { border-color: var(--success); background: color-mix(in srgb, var(--success) 20%, transparent); }
  .choices button[aria-pressed=true].wrong { border-color: var(--destructive); background: color-mix(in srgb, var(--destructive) 16%, transparent); }
  .feedback { margin-top: 8px; color: var(--muted-foreground); min-height: 21px; }
  @media (prefers-reduced-motion: reduce) { .cell, .bar { transition: none; } }
</style>
</head>
<body>
<h2>Binary search halves the list every step</h2>
<p class="lede">Pick a number to find, then step through. Each step looks at the middle and throws away the half that can't hold it.</p>
<div class="row">
  <label for="target">Find</label>
  <input id="target" type="range" min="0" max="15" value="14" aria-describedby="target-value">
  <span class="target" id="target-value" aria-live="polite">71</span>
</div>
<div class="cells" id="cells" role="list" aria-label="Sorted list"></div>
<div class="marks" id="marks" aria-hidden="true"></div>
<p class="note" id="note" aria-live="polite"></p>
<div class="row">
  <button id="back" type="button">Back</button>
  <button id="next" type="button" class="primary">Next step</button>
  <button id="reset" type="button">Reset</button>
  <span class="counter" id="counter"></span>
</div>
<div class="compare" aria-label="Comparisons needed">
  <span>Binary search</span><div><div class="bar" id="binary-bar"></div></div><span class="num" id="binary-num"></span>
  <span>Linear scan</span><div><div class="bar linear" id="linear-bar"></div></div><span class="num" id="linear-num"></span>
</div>
<div class="quiz">
  <p><b>Quick check:</b> how many steps does binary search need, at most, for 1,000,000 sorted items?</p>
  <div class="choices" id="choices">
    <button type="button" data-answer="20">About 20</button>
    <button type="button" data-answer="1000">About 1,000</button>
    <button type="button" data-answer="500000">About 500,000</button>
  </div>
  <p class="feedback" id="feedback" aria-live="polite"></p>
</div>
<script>
const values = [3, 7, 12, 18, 21, 26, 30, 34, 39, 45, 48, 53, 60, 67, 71, 80];
const $ = (id) => document.getElementById(id);
const cells = values.map((value) => {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.setAttribute('role', 'listitem');
  cell.textContent = value;
  $('cells').append(cell);
  const mark = document.createElement('span');
  $('marks').append(mark);
  return { cell, mark };
});
function trace(target) {
  const steps = [];
  let lo = 0, hi = values.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = values[mid];
    const found = value === target;
    steps.push({ lo, hi, mid, found,
      text: found
        ? '<b>Found ' + target + '</b> at position ' + mid + '.'
        : 'Middle is <b>' + value + '</b>, ' + (value < target ? 'smaller' : 'larger') + ' than ' + target + ': keep the ' + (value < target ? 'right' : 'left') + ' half.' });
    if (found) break;
    if (value < target) lo = mid + 1; else hi = mid - 1;
  }
  return steps;
}
let steps = [], step = -1;
function render() {
  const target = values[Number($('target').value)];
  $('target-value').textContent = target;
  const current = steps[step];
  cells.forEach(({ cell, mark }, index) => {
    const inRange = !current || (index >= current.lo && index <= current.hi);
    cell.className = 'cell' + (inRange ? '' : ' out') + (current && index === current.mid ? (current.found ? ' found' : ' mid') : '');
    mark.textContent = current ? (index === current.lo ? 'lo' : index === current.hi ? 'hi' : '') : '';
  });
  $('note').innerHTML = current ? current.text : 'All ' + values.length + ' numbers are in play. Press <b>Next step</b> to look at the middle.';
  $('counter').textContent = 'Step ' + Math.max(0, step + 1) + ' of ' + steps.length;
  $('back').disabled = step < 0;
  $('next').disabled = step >= steps.length - 1;
  const linear = values.indexOf(target) + 1;
  $('binary-bar').style.width = (steps.length / values.length) * 100 + '%';
  $('linear-bar').style.width = (linear / values.length) * 100 + '%';
  $('binary-num').textContent = steps.length;
  $('linear-num').textContent = linear;
}
function restart() { steps = trace(values[Number($('target').value)]); step = -1; render(); }
$('target').addEventListener('input', restart);
$('next').addEventListener('click', () => { step = Math.min(steps.length - 1, step + 1); render(); });
$('back').addEventListener('click', () => { step = Math.max(-1, step - 1); render(); });
$('reset').addEventListener('click', restart);
for (const choice of $('choices').querySelectorAll('button')) {
  choice.addEventListener('click', () => {
    const right = choice.dataset.answer === '20';
    for (const other of $('choices').querySelectorAll('button')) { other.setAttribute('aria-pressed', 'false'); other.className = ''; }
    choice.setAttribute('aria-pressed', 'true');
    choice.className = right ? 'right' : 'wrong';
    $('feedback').textContent = right
      ? 'Right: 2^20 is about a million, so 20 halvings are enough.'
      : 'Not quite: each step halves what is left, and 2^20 is already about a million.';
  });
}
restart();
</script>
</body>
</html>
`;
