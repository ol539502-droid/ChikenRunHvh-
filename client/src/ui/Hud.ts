import { ARMS_LADDER, JETPACK, MIN_LEVEL, MODES, PLAYER, TEAM_COLORS, WEAPONS, rankOf, rankProgress, teamName, type ChatMessage, type KillCause, type MatchRewardEvent, type MatchState, type ModeDef, type PlayerInfo, type RoomInfo, type RoundState, type Team, type WeaponId, KILL_FLAGS } from '@game/shared';
import { icon as drawnIcon } from './icons';
import { watchSettings } from '../settings';
import { killTags, shapeSvg, tagSvg, weaponShape } from './KillIcons';
import { gunIcon, prepareGunIcons } from './GunIcons';
import { CombatFeedback } from '../game/CombatFeedback';
import { CrosshairView } from './Crosshair';
import { clear, formatTime, h, hex } from './dom';

const KILLFEED_MS = 6000;

/** The end screen's score counts up (a score tick, not decoration); instant with reduced motion. */
const drawn = (name: 'egg' | 'smoke' | 'flash') => drawnIcon(name);

function countUp(el: HTMLElement, to: number): void {
  if (to <= 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = to.toLocaleString();
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / 900);
    el.textContent = Math.round(to * (1 - (1 - t) ** 3)).toLocaleString();
    if (t < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const CHAT_VISIBLE_MS = 10000;

/** A small kill-feed icon (the markup comes from KillIcons, never from a player). */
function icon(html: string, title: string): HTMLElement {
  const el = h('span', { class: 'kf-icon', title });
  el.innerHTML = html;
  return el;
}

/** "No-scope headshot through the wall, in mid-air" — or null for a plain kill. */
export function killSentence(flags: number, headshot: boolean): string | null {
  if (!flags) return null;
  const extras: string[] = [];
  if (flags & KILL_FLAGS.wallbang) extras.push('through the wall');
  if (flags & KILL_FLAGS.smoke) extras.push('through the smoke');
  if (flags & KILL_FLAGS.air) extras.push('in mid-air');
  if (flags & KILL_FLAGS.blind) extras.push('while blind');
  const head = `${flags & KILL_FLAGS.noscope ? 'no-scope ' : ''}${headshot ? 'headshot' : 'kill'}`;
  return [head, ...extras].join(extras.length > 1 ? ', ' : ' ').replace(/^, /, '');
}

function causeLabel(cause: KillCause): string {
  if (cause === 'egg') return 'Egg';
  if (cause === 'car') return 'Buggy';
  if (cause === 'world') return 'Fall';
  if (cause === 'bomb') return 'Bomb';
  return WEAPONS[cause as WeaponId]?.name ?? cause;
}

/** A player's name; developer accounts glow rainbow. */
function nameEl(name: string, team: Team, self: boolean, dev = false): HTMLElement {
  return h('span', { class: `name${self ? ' self' : ''}${dev ? ' rainbow' : ''}`, style: team ? `color:${hex(TEAM_COLORS[team])}` : undefined }, name);
}

/** A player's rank badge (level 1–10). */
function rankBadge(level: number | undefined): HTMLElement {
  const rank = rankOf(level ?? MIN_LEVEL);
  return h('span', { class: `rank-badge r${rank.level}`, title: `Level ${rank.level} · ${rank.name}` }, h('b', null, rank.level));
}

/** A plain name for tables: rank badge, and rainbow for developers. */
function nameText(info: PlayerInfo): HTMLElement {
  return h('span', { class: 'ranked' }, rankBadge(info.rank), info.dev ? h('span', { class: 'rainbow' }, info.name) : info.name);
}

export interface ScoreLine {
  info: PlayerInfo;
  self: boolean;
}

/** All in-game overlay UI. Pure DOM; text is set via text nodes only. */
export class Hud {
  readonly root: HTMLElement;
  readonly chatInput: HTMLInputElement;
  private readonly timer = h('div', { class: 'match-timer' });
  private readonly teamScores = h('div', { class: 'team-scores' });
  private readonly modeLabel = h('div', { class: 'mode-label' });
  private readonly stats = h('div', { class: 'hud-stats' });
  private readonly personalScore = h('div', { class: 'personal-score' });
  private readonly objective = h('div', { class: 'mode-objective' });
  private readonly damageNumber = h('div', { class: 'damage-number' });
  private readonly eliminationLabel = h('div', { class: 'elimination-label' });
  private readonly streakLabel = h('div', { class: 'streak-label' });
  private readonly elimination = h('div', { class: 'elimination' }, this.eliminationLabel, this.streakLabel);
  private readonly feedback = new CombatFeedback();
  private damageUntil = 0;
  private eliminationUntil = 0;
  private readonly roomCode = h('div', { class: 'room-code' });
  private readonly killfeed = h('div', { class: 'killfeed' });
  private readonly crosshair = new CrosshairView();
  private readonly hitmarker = h('div', { class: 'hitmarker' }, h('i'), h('i'), h('i'), h('i'));
  private readonly scope = h('div', { class: 'scope' });
  private readonly indicators = h('div', { class: 'damage-indicators' });
  private readonly vignette = h('div', { class: 'hurt-vignette' });
  private readonly hpFill = h('div', { class: 'fill' });
  private readonly hpText = h('span');
  private readonly armorFill = h('div', { class: 'fill' });
  private readonly armorText = h('span');
  private readonly armorBar = h('div', { class: 'bar armor' }, this.armorFill, this.armorText);
  private readonly fuelFill = h('div', { class: 'fill' });
  private readonly fuelLabel = h('span', null, 'JETPACK');
  private readonly fuelBar = h('div', { class: 'bar fuel' }, this.fuelFill, this.fuelLabel);
  private readonly hopBadge = h('div', { class: 'hop-badge' });
  private readonly weaponName = h('div', { class: 'weapon-name' });
  private readonly ammo = h('div', { class: 'ammo' });
  private readonly reloadBar = h('div', { class: 'reload-bar' }, h('div'));
  private readonly slots = h('div', { class: 'weapon-slots' });
  private readonly grenades = h('div', { class: 'grenades' });
  /** Big moments in the middle of the screen ("BOMB PLANTED"). */
  private readonly announcer = h('div', { class: 'announce', hidden: true });
  private announceTimer = 0;
  /** Markers on screen (bomb sites, the bomb). */
  private readonly markerLayer = h('div', { class: 'markers' });
  private readonly markerPool: HTMLElement[] = [];
  /** Flashbanged: the screen goes white and fades back. */
  private readonly flashOverlay = h('div', { class: 'flash-overlay' });
  private flashTimer = 0;
  private readonly banner = h('div', { class: 'banner' });
  private readonly toasts = h('div', { class: 'toasts' });
  private readonly death = h('div', { class: 'death-screen' });
  private readonly deathText = h('div', { class: 'death-title' });
  private readonly deathTimer = h('div', { class: 'death-timer' });
  private readonly scoreboard = h('div', { class: 'scoreboard panel' });
  /** The live top three (and you), in every mode. */
  private readonly miniBoard = h('div', { class: 'mini-board' });
  private miniKey = '';
  private readonly results = h('div', { class: 'results panel' });
  private readonly chatLog = h('div', { class: 'chat-log' });
  private readonly hint = h('div', { class: 'hint-bar' });
  /** ChikenBomb: money, round line, plant / defuse progress. */
  private readonly money = h('div', { class: 'money' });
  private readonly roundLine = h('div', { class: 'round-line' });
  private readonly progressText = h('span');
  private readonly progressFill = h('div', { class: 'fill' });
  private readonly progress = h('div', { class: 'bomb-progress' }, this.progressFill, this.progressText);

  private mode: ModeDef = MODES.ffa;
  /** Developer Misc switches. */
  showHitmarker = true;
  showDamageIndicators = true;
  showCrosshair = true;
  showScope = true;
  private flashEnabled = true;
  get showFlash(): boolean { return this.flashEnabled; }
  set showFlash(value: boolean) { this.flashEnabled=value;if(!value){window.clearTimeout(this.flashTimer);this.flashOverlay.hidden=true;} }
  private persistentFeed = false;
  get persistentKillfeed(): boolean { return this.persistentFeed; }
  set persistentKillfeed(value: boolean) { this.persistentFeed=value;if(!value)for(const row of Array.from(this.killfeed.children)){if(performance.now()-Number((row as HTMLElement).dataset.at)>KILLFEED_MS)row.remove();} }
  private hitmarkerUntil = 0;
  private lastSlotsKey = '';
  private lastGrenades = '';

  constructor(container: HTMLElement) {
    this.chatInput = h('input', { class: 'chat-input', maxlength: 120, placeholder: 'Say something… (Enter to send, Esc to cancel)' });
    this.chatInput.hidden = true;
    this.death.append(this.deathText, this.deathTimer);
    this.death.hidden = true;
    this.scoreboard.hidden = true;
    this.flashOverlay.hidden = true;
    this.results.hidden = true;
    this.scope.hidden = true;
    this.hint.hidden = true;
    this.money.hidden = true;
    this.roundLine.hidden = true;
    this.progress.hidden = true;
    this.damageNumber.hidden = true;
    this.elimination.hidden = true;

    this.root = h(
      'div',
      { id: 'hud', class: 'hud' },
      h('div', { class: 'hud-top-left' }, this.personalScore, this.stats, this.roomCode, this.miniBoard),
      h('div', { class: 'hud-top-center' }, this.modeLabel, this.timer, this.teamScores, this.roundLine, this.objective),
      h('div', { class: 'hud-top-right' }, this.killfeed),
      this.scope,
      this.vignette,
      this.indicators,
      this.crosshair.root,
      this.hitmarker,
      h('div', { class: 'combat-feedback', 'aria-hidden': 'true' }, this.damageNumber, this.elimination),
      this.banner,
      this.toasts,
      this.death,
      this.hint,
      this.progress,
      h('div', { class: 'hud-bottom-left' }, h('div', { class: 'chat' }, this.chatLog, this.chatInput), h('div', { class: 'vitals' }, this.money, this.hopBadge, h('div', { class: 'bar hp' }, this.hpFill, this.hpText), this.armorBar, this.fuelBar)),
      h('div', { class: 'hud-bottom-right' }, this.grenades, h('div', { class: 'weapon-panel' }, this.weaponName, this.ammo, this.reloadBar), this.slots),
      this.markerLayer,
      this.announcer,
      this.flashOverlay,
      this.scoreboard,
      this.results,
    );
    this.root.hidden = true;
    container.append(this.root);
    watchSettings((s) => this.crosshair.apply(s.crosshair));
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    // The kill feed's gun pictures are drawn once, shortly after the first match starts.
    if (visible) window.setTimeout(prepareGunIcons, 800);
  }

  setRoom(room: RoomInfo): void {
    this.mode = MODES[room.mode];
    this.miniKey = '';
    this.modeLabel.textContent = this.mode.name;
    this.objective.textContent = this.mode.training ? 'Practice · targets never shoot back · nothing counts' : this.mode.bomb ? 'Plant or defuse · Hold E on a site' : this.mode.id === 'ctf' ? 'Steal their flag. Bring it home.' : this.mode.zombies ? 'Survive the waves · B shop between waves · C builds a wall (10 s)' : this.mode.building ? 'B to build · X to change block' : `${this.mode.teams ? 'Team' : 'First to'} ${this.mode.scoreLimit} ${this.mode.teams ? 'kills to win' : 'kills wins'}`;
    this.roomCode.textContent = room.private ? `Room code: ${room.code}` : '';
    this.teamScores.hidden = !this.mode.teams || this.mode.zombies === true;
    clear(this.killfeed);
    clear(this.chatLog);
    this.resetCombatFeedback();
  }

  resetCombatFeedback(): void {
    this.feedback.reset();
    this.damageNumber.hidden = true;
    this.elimination.hidden = true;
    this.damageUntil = this.eliminationUntil = 0;
  }

  setPersonalScore(kills: number, deaths: number): void {
    const text = `${kills} K  /  ${deaths} D${this.feedback.streak >= 2 ? `  ·  ${this.feedback.streak} STREAK` : ''}`;
    if (this.personalScore.textContent !== text) this.personalScore.textContent = text;
    this.personalScore.classList.toggle('on-streak', this.feedback.streak >= 3);
  }

  setStats(ping: number | null, fps: number, players: number): void {
    this.stats.textContent = `${players} online · ${ping === null ? '–' : `${ping} ms`} · ${fps} fps`;
  }

  // ---------------------------------------------------------------------------
  // Vitals and weapon
  // ---------------------------------------------------------------------------

  /** While driving the fuel bar shows nitro (0–1) instead of jetpack fuel. */
  setNitro(nitro: number | null): void {
    const label = nitro === null ? 'JETPACK' : 'NITRO (SHIFT)';
    if (this.fuelLabel.textContent !== label) this.fuelLabel.textContent = label;
    this.fuelBar.classList.toggle('nitro', nitro !== null);
    if (nitro === null) return;
    this.fuelBar.hidden = false;
    this.fuelFill.style.width = `${Math.round(nitro * 100)}%`;
  }

  setVitals(hp: number, armor: number, fuel: number): void {
    const hpPct = Math.max(0, Math.min(100, (hp / PLAYER.maxHealth) * 100));
    this.hpFill.style.width = `${hpPct}%`;
    this.hpFill.classList.toggle('low', hpPct <= 30);
    this.hpText.textContent = `${Math.ceil(hp)} HP`;
    this.armorBar.hidden = armor <= 0;
    this.armorFill.style.width = `${Math.min(100, (armor / PLAYER.maxArmor) * 100)}%`;
    this.armorText.textContent = `${Math.ceil(armor)} ARMOR`;
    this.fuelBar.hidden = fuel <= 0;
    this.fuelFill.style.width = `${(fuel / JETPACK.maxFuel) * 100}%`;
    this.vignette.style.opacity = String(hpPct < 35 ? (35 - hpPct) / 50 : 0);
  }

  /** Actual momentum above the held weapon's normal running speed; never a granted bonus. */
  setHop(excessSpeed: number, max: number): void {
    const pct = Math.round(excessSpeed * 100);
    this.hopBadge.hidden = pct < 2;
    this.hopBadge.textContent = `🐇 Momentum +${pct}%`;
    this.hopBadge.classList.toggle('max', excessSpeed >= max - 0.01);
  }

  setWeapon(weapon: WeaponId, mag: number, reloading: boolean, reloadProgress: number, loadout: WeaponId[], slot: number): void {
    const w = WEAPONS[weapon];
    this.weaponName.textContent = w.name;
    this.ammo.textContent = w.melee ? '∞' : reloading ? 'Reloading…' : `${mag} / ${w.magazine}`;
    this.ammo.classList.toggle('empty', mag === 0 && !reloading && !w.melee);
    this.reloadBar.hidden = !reloading;
    (this.reloadBar.firstChild as HTMLElement).style.width = `${reloadProgress * 100}%`;
    const key = `${loadout.join()}|${slot}`;
    if (key !== this.lastSlotsKey) {
      this.lastSlotsKey = key;
      clear(this.slots);
      loadout.forEach((id, i) => this.slots.append(h('div', { class: `slot${i === slot ? ' active' : ''}` }, h('kbd', null, i + 1), WEAPONS[id].name)));
    }
  }

  setGrenades(eggs: number, smokes: number, flashes = 0): void {
    const key = `${eggs}|${smokes}|${flashes}`;
    if (key === this.lastGrenades) return;
    this.lastGrenades = key;
    clear(this.grenades);
    this.grenades.append(h('span', { class: eggs ? '' : 'none', title: 'Eggs' }, h('kbd', null, 'G'), drawn('egg'), eggs), h('span', { class: smokes ? '' : 'none', title: 'Smoke' }, h('kbd', null, 'Q'), drawn('smoke'), smokes), h('span', { class: flashes ? '' : 'none', title: 'Flashbangs' }, h('kbd', null, 'Z'), drawn('flash'), flashes));
  }

  /** A flashbang caught you: white for about `ms`, fading back over the last part. */
  flash(ms: number): void {
    if (!this.showFlash) return;
    const el = this.flashOverlay;
    const hold = ms * 0.5;
    const fade = ms - hold;
    window.clearTimeout(this.flashTimer);
    el.hidden = false;
    el.style.transition = 'none';
    el.style.opacity = String(Math.min(1, Math.max(0.55, ms / 2600)));
    void el.offsetWidth;
    el.style.transition = `opacity ${Math.round(fade)}ms ease-in ${Math.round(hold)}ms`;
    el.style.opacity = '0';
    this.flashTimer = window.setTimeout(() => (el.hidden = true), ms + 80);
  }

  setCrosshair(visible: boolean, spreadPx: number, scoped: boolean): void {
    this.crosshair.root.hidden = !visible || scoped || !this.showCrosshair;
    this.scope.hidden = !scoped || !this.showScope;
    this.crosshair.setSpread(spreadPx);
  }

  hit(headshot: boolean, killed: boolean, damage = 0): void {
    if (!this.showHitmarker) return;
    if (damage > 0) {
      const now = performance.now();
      this.damageNumber.textContent = String(this.feedback.hit(damage, headshot, now));
      this.damageNumber.classList.toggle('headshot', this.feedback.headshot);
      this.damageNumber.hidden = false;
      this.damageUntil = now + 800;
    }
    this.hitmarker.classList.toggle('kill', killed);
    this.hitmarker.classList.toggle('headshot', headshot);
    this.hitmarker.classList.add('show');
    this.hitmarkerUntil = performance.now() + (killed ? 350 : 140);
  }

  /** Red arc pointing at whoever hurt you. `angle` is relative to where you're facing (0 = in front). */
  damageFrom(angle: number): void {
    if (!this.showDamageIndicators) return;
    const el = h('div', { class: 'indicator', style: `transform: rotate(${angle}rad)` });
    this.indicators.append(el);
    setTimeout(() => el.remove(), 1000);
  }

  toast(text: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
    const el = h('div', { class: `toast ${kind}` }, text);
    this.toasts.append(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------------------------------------------------------------------------
  // Feed, chat, death
  // ---------------------------------------------------------------------------

  kill(killer: PlayerInfo | undefined, victim: PlayerInfo | undefined, cause: KillCause, headshot: boolean, selfPid: number, flags = 0): void {
    if (!victim) return;
    if (killer?.pid === selfPid && victim.pid !== selfPid) {
      const label = this.feedback.eliminate(performance.now());
      this.eliminationLabel.textContent = `${label} · ${victim.name}`;
      // A special kill says how: "NO-SCOPE HEADSHOT THROUGH THE WALL".
      const how = killSentence(flags, headshot)?.toUpperCase() ?? (headshot ? 'HEADSHOT' : '');
      this.streakLabel.textContent = this.feedback.streak >= 3 ? `${this.feedback.streak} IN A ROW${how ? ` · ${how}` : ''}` : how;
      this.elimination.classList.toggle('multi', this.feedback.chain > 1);
      this.elimination.hidden = false;
      this.eliminationUntil = performance.now() + 2400;
    }
    const involved = killer?.pid === selfPid || victim.pid === selfPid;
    // Like Counter-Strike: [blind] killer [weapon] [no scope] [smoke] [wall] [air] [headshot] victim.
    const row = h('div', { class: `kill${involved ? ' mine' : ''}` });
    const tags = killTags(flags, headshot);
    for (const kind of tags.before) row.append(icon(tagSvg(kind).html, tagSvg(kind).title));
    if (killer && killer.pid !== victim.pid) row.append(nameEl(killer.name, killer.team, killer.pid === selfPid, killer.dev));
    const picture = cause in WEAPONS ? gunIcon(cause as WeaponId) : null;
    if (picture) row.append(h('img', { class: 'kf-gun', src: picture.url, width: picture.width, height: picture.height, alt: causeLabel(cause), title: causeLabel(cause) }));
    else row.append(icon(shapeSvg(weaponShape(cause)), causeLabel(cause)));
    for (const kind of tags.after) row.append(icon(tagSvg(kind).html, tagSvg(kind).title));
    row.append(nameEl(victim.name, victim.team, victim.pid === selfPid, victim.dev));
    this.killfeed.prepend(row);
    row.dataset.at=String(performance.now());
    while (this.killfeed.children.length > 5) this.killfeed.lastElementChild?.remove();
    setTimeout(() => { if (!this.persistentKillfeed) row.classList.add('fade'); }, KILLFEED_MS);
    setTimeout(() => { if (!this.persistentKillfeed) row.remove(); }, KILLFEED_MS + 600);
  }

  chat(msg: ChatMessage, self: boolean): void {
    const line = msg.pid === 0 ? h('div', { class: 'line system' }, msg.text) : h('div', { class: 'line' }, ...(msg.teamOnly ? [h('span', { class: 'chat-team' }, '[TEAM] ')] : []), nameEl(msg.name, msg.team, self, msg.dev), ': ', msg.text);
    this.chatLog.append(line);
    while (this.chatLog.children.length > 8) this.chatLog.firstElementChild?.remove();
    setTimeout(() => line.classList.add('old'), CHAT_VISIBLE_MS);
  }

  setChatOpen(open: boolean, teamOnly = false): void {
    this.chatInput.hidden = !open;
    this.chatInput.classList.toggle('team', teamOnly);
    this.chatInput.placeholder = teamOnly ? 'Team chat… (Enter to send, Esc to cancel)' : 'Say something… (Enter to send, Esc to cancel)';
    this.chatLog.classList.toggle('open', open);
    if (open) {
      this.chatInput.value = '';
      this.chatInput.focus();
    } else {
      this.chatInput.blur();
    }
  }

  showDeath(killer: PlayerInfo | undefined, cause: KillCause, selfPid: number, flags = 0, headshot = false): void {
    this.feedback.died();
    this.damageNumber.hidden = true;
    this.elimination.hidden = true;
    clear(this.deathText);
    if (!killer || killer.pid === selfPid) this.deathText.append(cause === 'egg' ? 'Your own egg got you!' : 'You died');
    else {
      this.deathText.append('Plucked by ', nameEl(killer.name, killer.team, false, killer.dev), ` · ${causeLabel(cause)}`);
      // "— a no-scope headshot through the wall, in mid-air"
      const how = killSentence(flags, headshot);
      if (how) this.deathText.append(h('div', { class: 'death-how' }, `${/^[aeiou]/.test(how) ? 'an' : 'a'} ${how}`));
    }
    this.death.hidden = false;
  }

  /** ChikenBomb: dead until the next round. */
  setDeathWaiting(text: string): void {
    this.deathTimer.textContent = text;
  }

  setDeathTimer(msLeft: number): void {
    this.deathTimer.textContent = msLeft > 0 ? `Respawning in ${Math.ceil(msLeft / 1000)}…` : 'Respawning…';
  }

  hideDeath(): void {
    this.death.hidden = true;
  }

  /** One line of context help above the weapon bar (driving, building, carrying the flag). */
  setHint(text: string | null): void {
    this.hint.hidden = text === null;
    if (this.hint.textContent !== (text ?? '')) this.hint.textContent = text ?? '';
  }

  // ---------------------------------------------------------------------------
  // Match, scores, results
  // ---------------------------------------------------------------------------

  setMatch(match: MatchState, serverNow: number, players: number): void {
    const left = match.endsAt === null ? null : match.endsAt - serverNow;
    this.timer.textContent = match.phase === 'playing' && left !== null ? formatTime(left) : '';
    this.timer.classList.toggle('urgent', match.phase === 'playing' && left !== null && left < 30_000);
    let banner = '';
    if (match.phase === 'waiting') banner = `Waiting for players · ${players}/${this.mode.minPlayers}`;
    if (match.phase === 'countdown' && left !== null) banner = `Match starts in ${Math.max(1, Math.ceil(left / 1000))}`;
    this.banner.textContent = banner;
    this.banner.hidden = banner === '';
    this.results.hidden = match.phase !== 'ended';
  }

  // ---------------------------------------------------------------------------
  // ChikenBomb
  // ---------------------------------------------------------------------------

  setMoney(money: number | null): void {
    this.money.hidden = money === null;
    if (money !== null) this.money.textContent = `$${money.toLocaleString()}`;
  }

  /**
   * The round: a timer (buy time, round clock or bomb fuse) and a line under the team scores.
   * Takes over the match timer and banner while a ChikenBomb match is on.
   */
  setRound(r: RoundState, serverNow: number, selfTeam: Team): void {
    const left = r.endsAt === null ? null : Math.max(0, r.endsAt - serverNow);
    const clock = left === null ? '' : formatTime(left);
    let line = '';
    let banner = '';
    switch (r.phase) {
      case 'warmup':
        line = `Warmup · ${clock}`;
        banner = left !== null && left < 5000 ? `Round 1 in ${Math.max(1, Math.ceil(left / 1000))}` : '';
        break;
      case 'buy':
        line = `Round ${r.round} · Buy time ${clock}`;
        banner = `Buy time: press B · ${Math.max(1, Math.ceil((left ?? 0) / 1000))}`;
        break;
      case 'live':
        line = `Round ${r.round}`;
        break;
      case 'planted':
        line = `💣 Bomb planted at ${r.bomb.site}`;
        break;
      case 'over': {
        const won = r.winner === selfTeam;
        banner = r.winner ? `${teamName(this.mode, r.winner)} win the round${won ? ' 🎉' : ''}` : '';
        line = `Round ${r.round} over`;
        break;
      }
    }
    this.timer.textContent = r.phase === 'over' ? '' : clock;
    this.timer.classList.toggle('urgent', (r.phase === 'live' || r.phase === 'planted') && left !== null && left < 15_000);
    this.timer.classList.toggle('bomb', r.phase === 'planted');
    this.roundLine.hidden = line === '';
    this.roundLine.textContent = line;
    if (banner || r.phase !== 'warmup') {
      this.banner.textContent = banner;
      this.banner.hidden = banner === '';
    }
  }

/** Arms Race: your step on the ladder, what you hold and what comes next. */
  setArmsLevel(level: number, total: number, now: string, next: string | null): void {
    this.roundLine.hidden = false;
    this.roundLine.textContent = `Level ${level + 1}/${total} · ${now}${next ? ` → next: ${next}` : ' · final kill wins!'}`;
  }

  /** Planting / defusing progress (0..1), or null to hide it. */
/** A big centred message for a moment ("💣 BOMB PLANTED"). */
  announce(title: string, sub: string, kind: 'good' | 'bad' | 'info' = 'info'): void {
    clear(this.announcer);
    this.announcer.className = `announce ${kind}`;
    this.announcer.append(h('b', null, title), h('span', null, sub));
    this.announcer.hidden = false;
    void this.announcer.offsetWidth;
    this.announcer.classList.add('show');
    window.clearTimeout(this.announceTimer);
    this.announceTimer = window.setTimeout(() => (this.announcer.hidden = true), 2800);
  }

  /** Screen-space markers (already projected by the caller). */
  setMarkers(list: { x: number; y: number; label: string; sub: string; kind: string }[]): void {
    while (this.markerPool.length < list.length) {
      const el = h('div', { class: 'marker' }, h('b'), h('small'));
      this.markerPool.push(el);
      this.markerLayer.append(el);
    }
    this.markerPool.forEach((el, i) => {
      const m = list[i];
      el.hidden = !m;
      if (!m) return;
      el.className = `marker ${m.kind}`;
      el.style.transform = `translate(${Math.round(m.x)}px, ${Math.round(m.y)}px)`;
      const [label, sub] = el.children as unknown as [HTMLElement, HTMLElement];
      if (label.textContent !== m.label) label.textContent = m.label;
      if (sub.textContent !== m.sub) sub.textContent = m.sub;
    });
  }

  setBombProgress(label: string | null, progress: number): void {
    this.progress.hidden = label === null;
    if (label === null) return;
    this.progressText.textContent = label;
    this.progressFill.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
  }

  setTeamScores(scores: [number, number], selfTeam: Team): void {
    if (!this.mode.teams) return;
    clear(this.teamScores);
    for (const team of [1, 2] as const) {
      this.teamScores.append(
        h('div', { class: `team t${team}${team === selfTeam ? ' mine' : ''}` }, h('span', null, teamName(this.mode, team)), h('b', null, scores[team - 1]), h('small', null, `/ ${this.mode.scoreLimit}`)),
      );
    }
  }

  setScoreboardVisible(visible: boolean): void {
    this.scoreboard.hidden = !visible;
  }

  renderScoreboard(lines: ScoreLine[], teamScores: [number, number], ping: number | null): void {
    clear(this.scoreboard);
    const table = (rows: ScoreLine[], title: string | null, team: Team) => {
      const t = h('table', { class: `scores${team ? ` t${team}` : ''}` });
      if (title) t.append(h('caption', null, title));
      t.append(h('tr', null, h('th', null, 'Chicken'), h('th', null, 'K'), h('th', null, 'D'), h('th', null, this.mode.armsRace ? 'Level' : 'Score')));
      for (const { info, self } of rows) {
        t.append(
          h('tr', { class: self ? 'self' : '' }, h('td', null, nameText(info), info.bot ? h('small', null, ' bot') : null, self && ping !== null ? h('small', null, ` ${ping}ms`) : null), h('td', null, info.kills), h('td', null, info.deaths), h('td', null, info.score)),
        );
      }
      return t;
    };
    const sorted = [...lines].sort((a, b) => b.info.score - a.info.score || b.info.kills - a.info.kills);
    this.scoreboard.append(h('h3', null, this.mode.name));
    if (this.mode.teams) {
      const wrap = h('div', { class: 'team-tables' });
      for (const team of [1, 2] as const) {
        wrap.append(table(sorted.filter((l) => l.info.team === team), `${teamName(this.mode, team)} · ${teamScores[team - 1]}`, team));
      }
      this.scoreboard.append(wrap);
    } else {
      this.scoreboard.append(table(sorted, null, 0));
    }
  }

  renderResults(match: MatchState, lines: ScoreLine[], teamScores: [number, number], winner: PlayerInfo | undefined, mvp: PlayerInfo | undefined, selfWon: boolean): void {
    clear(this.results);
    let title: string;
    if (this.mode.teams) title = match.winnerTeam ? `${teamName(this.mode, match.winnerTeam)} team wins!` : "It's a draw!";
    else title = winner ? `${winner.name} wins!` : 'No winner';
    this.results.append(h('h2', { class: `result-kicker${selfWon ? ' won' : ''}` }, title));
    const self = lines.find((line) => line.self)?.info;
    if (self) {
      const big = h('div', { class: 'result-score' }, '0');
      this.results.append(big, h('div', { class: 'result-score-label' }, this.mode.armsRace ? 'guns climbed' : 'your score'));
      countUp(big, self.score);
    }
    this.results.append(h('div', { class: 'next-match' }), h('div', { class: 'result-leave' }, 'Esc for the menu'));
    if (self) {
      const stat = (value: number | string, label: string) => h('div', null, h('b', null, value), h('span', null, label));
      this.results.append(h('div', { class: 'result-stats' }, stat(self.kills, 'PLUCKS'), stat(self.deaths, 'DEATHS'), stat((self.kills / Math.max(1, self.deaths)).toFixed(2), 'K / D'), stat(this.feedback.bestStreak, 'BEST STREAK')));
    }
    if (this.mode.teams) this.results.append(h('div', { class: 'final-score' }, `${teamScores[0]} : ${teamScores[1]}`));
    if (mvp) this.results.append(h('div', { class: 'mvp' }, 'MVP: ', nameText(mvp), ` · ${mvp.kills} kills`));
    const sorted = [...lines].sort((a, b) => b.info.score - a.info.score);
    const t = h('table', { class: 'scores' }, h('tr', null, h('th', null, '#'), h('th', null, 'Chicken'), h('th', null, 'K'), h('th', null, 'D'), h('th', null, 'Score')));
    sorted.forEach(({ info, self }, i) => {
      t.append(h('tr', { class: self ? 'self' : '', style: info.team ? `color:${hex(TEAM_COLORS[info.team])}` : undefined }, h('td', null, i + 1), h('td', null, nameText(info)), h('td', null, info.kills), h('td', null, info.deaths), h('td', null, info.score)));
    });
    this.results.append(h('div', { class: 'reward' }), t);
  }

  setResultsCountdown(msLeft: number): void {
    const el = this.results.querySelector('.next-match');
    if (el) el.textContent = `Next match in ${Math.max(0, Math.ceil(msLeft / 1000))}`;
  }

  showReward(e: MatchRewardEvent): void {
    const el = this.results.querySelector('.reward');
    if (!el) return;
    const { rank, next, progress } = rankProgress(e.xpTotal);
    const xpTotal = e.xpTotal;
    clear(el);
    el.append(
      h('div', null, `+${e.coins} coins (you have ${e.total})` + (e.ranked ? ` · ${e.xp >= 0 ? '+' : ''}${e.xp} rank points` : '')),
      h(
        'div',
        { class: 'rank-line' },
        `Level ${rank.level} · ${rank.name}`,
        h('small', null, (next ? ` · ${next.xp - xpTotal} points to ${next.name}` : ' · top rank!') + (e.ranked ? '' : ' · levels move in FaceChiken')),
      ),
      h('div', { class: 'xp-bar' }, h('i', { style: `width:${Math.round(progress * 100)}%` })),
    );
    if (e.levelCoins > 0) el.append(h('div', { class: 'rank-up' }, `Level up! +${e.levelCoins} coins`));
  }

  /** The live leaders: top three, plus you if you're further down. Skipped in Sandbox. */
  renderMiniBoard(lines: ScoreLine[]): void {
    const sorted = this.mode.building || this.mode.training ? [] : [...lines].sort((a, b) => b.info.score - a.info.score || b.info.kills - a.info.kills);
    const mine = sorted.findIndex((l) => l.self);
    const shown = sorted.slice(0, 3);
    if (mine >= 3) shown.push(sorted[mine]!);
    const score = (info: PlayerInfo) => (this.mode.armsRace ? `${info.score}/${ARMS_LADDER.length}` : String(info.score));
    const key = shown.map((l) => `${sorted.indexOf(l)}:${l.info.pid}:${l.info.name}:${l.info.team}:${l.info.rank}:${score(l.info)}`).join('|');
    if (key === this.miniKey) return;
    this.miniKey = key;
    this.miniBoard.hidden = shown.length === 0;
    clear(this.miniBoard);
    this.miniBoard.append(h('div', { class: 'mini-title' }, this.mode.armsRace ? 'Leaders · gun' : 'Leaders'));
    for (const l of shown) {
      this.miniBoard.append(
        h(
          'div',
          { class: `mini-row${l.self ? ' self' : ''}` },
          h('span', { class: 'mini-place' }, sorted.indexOf(l) + 1),
          rankBadge(l.info.rank),
          nameEl(l.info.name, l.info.team, l.self, l.info.dev),
          h('span', { class: 'mini-score' }, score(l.info)),
        ),
      );
    }
  }

  update(): void {
    const now = performance.now();
    if (this.damageUntil && now > this.damageUntil) {
      this.damageNumber.hidden = true;
      this.damageUntil = 0;
    }
    if (this.eliminationUntil && now > this.eliminationUntil) {
      this.elimination.hidden = true;
      this.eliminationUntil = 0;
    }
    if (this.hitmarkerUntil && performance.now() > this.hitmarkerUntil) {
      this.hitmarker.classList.remove('show');
      this.hitmarkerUntil = 0;
    }
  }
}
