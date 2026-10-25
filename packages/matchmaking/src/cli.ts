import { runSimulation } from './simulator.js';

const players = Array.from({ length: 20 }, (_, index) => ({
  userId: `player-${index + 1}`,
  displayName: `Player ${index + 1}`,
  skill: Math.round((2.5 + ((index * 7) % 20) / 10) * 4) / 4,
  initialWaitMinutes: index % 4,
}));

const report = runSimulation({
  seed: 424242,
  players,
  courtCount: 2,
  rounds: 30,
  warmupRounds: 5,
});

console.log(`Seed: ${report.seed}, rounds: ${report.rounds}, courts: 2`);
console.log(
  `Games played: min ${Math.min(...report.perPlayer.map((p) => p.gamesPlayed))}, max ${Math.max(...report.perPlayer.map((p) => p.gamesPlayed))}`,
);
console.log(`Max disparity: ${report.maxPlayDisparity}`);
console.log(`Average wait: ${report.averageWaitMinutes} min, p95: ${report.p95WaitMinutes} min`);
console.log(`Court utilization: ${(report.courtUtilization * 100).toFixed(1)}%`);
console.log(`Repeated partnerships: ${report.repeatedPartnerships}`);
console.log(`Starvation incidents: ${report.starvationIncidents}`);
console.log(`Warnings: ${report.warnings.length > 0 ? report.warnings.join(' | ') : 'none'}`);
console.log('');
for (const player of report.perPlayer) {
  console.log(
    `${player.displayName.padEnd(10)} skill ${player.skill.toFixed(2)}  games ${String(player.gamesPlayed).padStart(2)}  wins ${String(player.wins).padStart(2)}  avg wait ${player.averageWaitMinutes.toFixed(1)}m`,
  );
}
