// Deterministic punter-style usernames for bots 1..100
const A = ["Deano","Tommy","Gaz","Kev","Lee","Jordan","Ash","Callum","Rhys","Dai","Macca","Robbo","Stevo","Jonesy","Smudge","Baz","Nath","Liam","Connor","Shane","Dylan","Kieran","Owen","Luke","Jamie","Ryan","Sean","Danny","Craig","Mark","Paul","Rob","Scott","Wayne","Lewis","Ben","Jake","Josh","Matty","Ste","Micky","Terry","Gav","Carl","Dean","Sam","Jack","Ollie","Harry","Charlie"];
const B = ["Acca","Bets","Punts","Tips","FC","Wins","88","92","10","7","Bet","Lad","Tekkers","Flutter","Banker","Nap","Longshot","Treble","Edge","Fold"];
const C = ["", "_", "x", "88", "99", "01", "UK", "Cymru", "07", "21"];
module.exports = b => {
  const i = (b * 7919) % A.length, j = (b * 104729) % B.length, k = (b * 1301) % C.length;
  return A[i] + B[j] + C[k];
};
