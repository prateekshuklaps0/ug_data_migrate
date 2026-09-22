/** Terminal progress bar with rate + ETA. Degrades to plain lines when not a TTY. */
class Progress {
  constructor(total, label = '') {
    this.total = total; this.label = label; this.n = 0;
    this.start = Date.now(); this.last = 0;
    this.tty = process.stdout.isTTY;
  }
  tick(k = 1, note = '') {
    this.n += k;
    const now = Date.now();
    if (now - this.last < 100 && this.n < this.total) return;
    this.last = now;
    this.render(note);
  }
  render(note = '') {
    const el = (Date.now() - this.start) / 1000;
    const frac = this.total ? this.n / this.total : 1;
    const rate = el > 0 ? this.n / el : 0;
    const eta = rate > 0 && this.n < this.total ? (this.total - this.n) / rate : 0;
    const w = 28;
    const filled = Math.round(frac * w);
    const bar = '█'.repeat(filled) + '░'.repeat(w - filled);
    const line = `${this.label.padEnd(22)} [${bar}] ${String(this.n).padStart(String(this.total).length)}/${this.total}` +
      ` ${(frac * 100).toFixed(1).padStart(5)}%  ${rate.toFixed(0).padStart(5)}/s  elapsed ${fmt(el)}  eta ${this.n>=this.total?'done':fmt(eta)}${note?'  '+note:''}`;
    if (this.tty) process.stdout.write('\r' + line.padEnd(process.stdout.columns ? process.stdout.columns - 1 : 150));
    else if (this.n >= this.total || this.n % Math.max(1, Math.floor(this.total / 10)) === 0) console.log(line);
  }
  done(note = '') { this.n = this.total; this.render(note); if (this.tty) process.stdout.write('\n'); }
}
const fmt = s => {
  if (!isFinite(s)) return '--';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}h${String(m).padStart(2,'0')}m` : m ? `${m}m${String(x).padStart(2,'0')}s` : `${x}s`;
};
module.exports = { Progress, fmtDuration: fmt };
