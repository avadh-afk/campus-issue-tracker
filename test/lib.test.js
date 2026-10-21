const test = require('node:test');
const assert = require('node:assert');
const { canTransition, suggest, similarity } = require('../lib');

test('valid and invalid status transitions', () => {
  assert.ok(canTransition('Submitted', 'Under Review'));
  assert.ok(canTransition('In Progress', 'Awaiting Student Confirmation'));
  assert.ok(canTransition('Resolved', 'Reopened'));
  assert.ok(!canTransition('Submitted', 'Resolved'));
  assert.ok(!canTransition('Resolved', 'In Progress'));
});

test('classifier suggests category and priority', () => {
  const s = suggest('The Wi-Fi keeps disconnecting in Computer Lab 3');
  assert.strictEqual(s.category, 'Wi-Fi and Internet');
  assert.strictEqual(s.priority, 'High');
  assert.strictEqual(s.method, 'rule-based');
});

test('safety hazards are always Critical', () => {
  assert.strictEqual(suggest('Exposed wire sparking near the canteen').priority, 'Critical');
});

test('unknown text falls back to Other / Medium', () => {
  const s = suggest('something odd happened');
  assert.strictEqual(s.category, 'Other');
  assert.strictEqual(s.priority, 'Medium');
});

test('similar reports score higher than unrelated ones', () => {
  const a = 'Water tap leaking in Hostel A washroom';
  assert.ok(similarity(a, 'Hostel A washroom tap is leaking water') > 0.4);
  assert.ok(similarity(a, 'Projector not working in lab') < 0.1);
});
