const SEAT_LABEL = ["South", "West", "North", "East"];
const EMOTES = ["👏", "😂", "😱", "🔥", "🤝", "💀"];
const DIFFICULTIES = ["easy", "normal", "hard"];
const TARGET_DEAL_CHOICES = [3, 5, 7];
const TURN_TIMER_CHOICES = [0, 15, 30, 45, 60, 90];
const MAX_PLAYERS_PER_ROOM = 12;
const CHAT_MAX_LEN = 200, CHAT_RING = 50, NAME_MAX = 16, MAX_KICKED = 64;

const DEFAULT_DELAYS = {
  ai: 800,          // AI "thinking" pause
  trick: 1600,      // show a completed trick
  round: 30000,     // roundEnd fallback when not everyone clicks ready
  drop: 15000,      // hold a lobby seat through a brief disconnect
  expire: 30 * 60 * 1000, // delete a room this long after it empties
};

export {
  SEAT_LABEL, EMOTES, DIFFICULTIES, TARGET_DEAL_CHOICES, TURN_TIMER_CHOICES,
  MAX_PLAYERS_PER_ROOM, CHAT_MAX_LEN, CHAT_RING, NAME_MAX, MAX_KICKED, DEFAULT_DELAYS,
};
