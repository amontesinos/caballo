const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClickSync } = require('../click-sync.js');

async function microtasks() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function setup(behavior) {
    let now = 0, nextId = 0;
    const timers = new Map();
    const writes = [];
    const states = [];
    function setTimer(fn, delay) {
        const id = ++nextId;
        timers.set(id, { fn, at: now + delay });
        return id;
    }
    const sync = createClickSync({
        now: () => now, setTimer, clearTimer: id => timers.delete(id), random: () => 0,
        onChange: state => states.push(state),
        write(name) {
            return new Promise((resolve, reject) => {
                const write = { name, at: now, resolve, reject };
                writes.push(write);
                if (behavior) behavior(write, setTimer);
            });
        }
    });
    async function tick(ms) {
        const target = now + ms;
        await microtasks();
        for (let iterations = 0; ; iterations++) {
            assert(iterations < 10000, 'scheduler must not spin');
            const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > target) break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].fn();
            await microtasks();
        }
        now = target;
        await microtasks();
    }
    return { sync, writes, states, tick };
}

test('first click sends immediately; later clicks stream individually without waiting for acknowledgments', async () => {
    const h = setup((write, schedule) => schedule(write.resolve, 200));
    h.sync.setConnected(true);
    for (let i = 0; i < 12; i++) {
        h.sync.enqueue('Alice');
        assert.equal(h.writes.length, i + 1, 'a normal click should not wait for a prior round trip');
        assert.equal(h.writes[i].at, i * 100);
        await h.tick(100);
    }
    await h.tick(200);
    assert.equal(h.sync.getState().pendingCount, 0);
    assert(h.states.some(state => state.inFlight > 1));
});

test('pending display counts include queued clicks but exclude SDK-owned in-flight clicks', async () => {
    const h = setup();
    h.sync.enqueue('Alice');
    h.sync.enqueue('Bob');
    assert.equal(h.sync.getState().queuedCount, 2);
    assert.equal(h.sync.getState().queuedByName.get('Alice'), 1);
    h.sync.setConnected(true);
    assert.equal(h.writes.length, 1);
    assert.equal(h.sync.getState().queuedCount, 1);
    assert.equal(h.sync.getState().queuedByName.get('Bob'), 1);
    await h.tick(60);
    assert.equal(h.sync.getState().queuedCount, 0);
    assert.equal(h.sync.getState().inFlight, 2);
    h.writes[0].reject(new Error('PERMISSION_DENIED'));
    await microtasks();
    assert.equal(h.sync.getState().queuedCount, 1);
    assert.equal(h.sync.getState().queuedByName.get('Alice'), 1);
});

test('changing nickname cannot redirect a queued click or its retry', async () => {
    const h = setup();
    h.sync.setConnected(true);
    h.sync.enqueue('Alice');
    h.sync.enqueue('Alice');
    h.sync.enqueue('Bob');
    await h.tick(120);
    assert.deepEqual(h.writes.map(write => write.name), ['Alice', 'Alice', 'Bob']);
    h.writes[0].reject(new Error('PERMISSION_DENIED'));
    h.writes[1].resolve();
    h.writes[2].resolve();
    await h.tick(100);
    assert.equal(h.writes[3].name, 'Alice');
    h.writes[3].resolve();
    await microtasks();
    assert.equal(h.sync.getState().pendingCount, 0);
});

test('a burst of independent rejections does not exhaust a shared retry budget or erase clicks', async () => {
    const h = setup();
    h.sync.setConnected(true);
    for (let i = 0; i < 8; i++) h.sync.enqueue('Alice');
    await h.tick(450);
    assert.equal(h.writes.length, 8);
    for (const write of h.writes) write.reject(new Error('PERMISSION_DENIED'));
    await microtasks();
    assert.equal(h.sync.getState().paused, false);
    assert.equal(h.sync.getState().pendingCount, 8);
    for (let i = 0; i < 8; i++) {
        await h.tick(60);
        assert.equal(h.writes.length, 9 + i);
        h.writes[8 + i].resolve();
    }
    await microtasks();
    assert.equal(h.sync.getState().pendingCount, 0);
});

test('slow acknowledgments are bounded and never cause timeout resubmission', async () => {
    const h = setup();
    h.sync.setConnected(true);
    for (let i = 0; i < 20; i++) h.sync.enqueue('Alice');
    await h.tick(60000);
    assert.equal(h.writes.length, 8);
    assert.equal(h.sync.getState().pendingCount, 20);
    h.writes[0].resolve();
    await microtasks();
    assert.equal(h.writes.length, 9);
    assert.equal(h.sync.getState().pendingCount, 19);
});

test('offline clicks wait locally and reconnect resumes without duplicating unsettled writes', async () => {
    const h = setup();
    h.sync.enqueue('Alice');
    await h.tick(1000);
    assert.equal(h.writes.length, 0);
    h.sync.setConnected(true);
    assert.equal(h.writes.length, 1);
    h.sync.setConnected(false);
    h.sync.enqueue('Bob');
    await h.tick(1000);
    assert.equal(h.writes.length, 1);
    h.sync.setConnected(true);
    assert.deepEqual(h.writes.map(write => write.name), ['Alice', 'Bob']);
    h.writes.forEach(write => write.resolve());
    await microtasks();
    assert.equal(h.sync.getState().pendingCount, 0);
});

test('persistent rejection pauses with all clicks retained; explicit retry recovers', async () => {
    let rejecting = true;
    const h = setup((write, schedule) => schedule(() => {
        if (rejecting) write.reject(new Error('PERMISSION_DENIED'));
        else write.resolve();
    }, 1));
    h.sync.setConnected(true);
    h.sync.enqueue('Alice');
    await h.tick(20000);
    assert.equal(h.writes.length, 6);
    assert.equal(h.sync.getState().paused, true);
    assert.equal(h.sync.getState().pendingCount, 1);
    h.sync.enqueue('Bob');
    await h.tick(20000);
    assert.equal(h.writes.length, 6, 'new clicks must not reset a failed click retry budget');
    assert.equal(h.sync.getState().pendingCount, 2);
    rejecting = false;
    h.sync.retry();
    await h.tick(200);
    assert.deepEqual(h.writes.slice(6).map(write => write.name), ['Alice', 'Bob']);
    assert.equal(h.sync.getState().pendingCount, 0);
    assert.equal(h.sync.getState().paused, false);
});

test('synchronous write errors also preserve the click for retry', async () => {
    const h = setup(() => { throw new Error('temporary write error'); });
    h.sync.setConnected(true);
    h.sync.enqueue('Alice');
    await microtasks();
    assert.equal(h.sync.getState().queuedCount, 1);
    assert.equal(h.sync.getState().pendingCount, 1);
});
