// Pure business logic (no dependencies) so it is easy to test.
const STATUSES = ['Submitted', 'Under Review', 'Assigned', 'In Progress',
  'Awaiting Student Confirmation', 'Resolved', 'Rejected', 'Reopened'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

const TRANSITIONS = {
  'Submitted': ['Under Review', 'Rejected'],
  'Under Review': ['Assigned', 'Rejected'],
  'Assigned': ['In Progress', 'Rejected'],
  'In Progress': ['Awaiting Student Confirmation'],
  'Awaiting Student Confirmation': ['Resolved', 'Reopened'],
  'Resolved': ['Reopened'],
  'Rejected': ['Reopened'],
  'Reopened': ['Assigned', 'In Progress']
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

const RULES = [
  { category: 'Wi-Fi and Internet', words: ['wifi', 'wi-fi', 'internet', 'network', 'lan', 'router', 'connection', 'disconnecting'] },
  { category: 'Electricity and Lighting', words: ['light', 'lights', 'electric', 'electricity', 'power', 'fan', 'switch', 'socket', 'bulb', 'wire', 'wiring', 'spark'] },
  { category: 'Classrooms and Laboratories', words: ['classroom', 'lab', 'laboratory', 'projector', 'whiteboard', 'computer', 'lecture'] },
  { category: 'Washrooms and Sanitation', words: ['washroom', 'toilet', 'restroom', 'flush', 'sanitation', 'urinal'] },
  { category: 'Water Supply and Leakage', words: ['water', 'leak', 'leakage', 'tap', 'pipe', 'drinking', 'cooler'] },
  { category: 'Hostel and Accommodation', words: ['hostel', 'mess', 'warden', 'dorm', 'room'] },
  { category: 'Furniture and Equipment', words: ['bench', 'chair', 'desk', 'table', 'furniture', 'door', 'window'] },
  { category: 'Roads, Parking and Transport', words: ['road', 'pothole', 'parking', 'bus', 'transport'] },
  { category: 'Library Facilities', words: ['library', 'book', 'books', 'reading'] },
  { category: 'Cleanliness and Waste', words: ['garbage', 'waste', 'dustbin', 'dirty', 'clean', 'smell', 'trash'] },
  { category: 'Safety and Accessibility', words: ['fire', 'unsafe', 'safety', 'ramp', 'harassment', 'theft', 'security', 'cctv', 'accident'] }
];
// Safety rules: these always raise priority, regardless of upvotes.
const CRITICAL = ['fire', 'electrocut', 'shock', 'spark', 'gas leak', 'collapse', 'short circuit', 'exposed wire', 'harass', 'assault', 'injur', 'flood'];
const HIGH = ['not working', 'no water', 'power cut', 'outage', 'disconnect', 'broken', 'leak', 'blocked', 'overflow'];
const LOW = ['minor', 'paint', 'suggestion', 'cosmetic'];

const STOP = new Set('the a an is are was were in on at of to for and or it this that with not no be has have had my our there from by as'.split(' '));
const tokens = t => (String(t).toLowerCase().match(/[a-z0-9-]+/g) || []).filter(w => w.length > 2 && !STOP.has(w));

// Honest fallback classifier: keyword rules, not a language model.
function suggest(text) {
  const lower = String(text).toLowerCase();
  const words = new Set(tokens(lower));
  let best = null, bestScore = 0;
  for (const r of RULES) {
    const score = r.words.filter(w => words.has(w) || (w.includes(' ') && lower.includes(w))).length;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  let priority = 'Medium', reason = 'Default priority for routine issues.';
  if (CRITICAL.some(w => lower.includes(w))) { priority = 'Critical'; reason = 'Possible safety hazard, so it is prioritised regardless of votes.'; }
  else if (HIGH.some(w => lower.includes(w))) { priority = 'High'; reason = 'Service seems unavailable or damaged, which may affect several people.'; }
  else if (LOW.some(w => lower.includes(w))) { priority = 'Low'; reason = 'Looks minor or cosmetic.'; }
  return { category: best ? best.category : 'Other', priority, reason, method: 'rule-based' };
}

function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

module.exports = { STATUSES, PRIORITIES, TRANSITIONS, canTransition, suggest, similarity };
