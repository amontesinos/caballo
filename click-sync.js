/* Individual clicks stay associated with their original nickname until confirmed. */
(function (root) {
    'use strict';

    function createClickSync(options) {
        const write = options.write;
        const onChange = options.onChange || (() => {});
        const now = options.now || (() => performance.now());
        const setTimer = options.setTimer || setTimeout;
        const clearTimer = options.clearTimer || clearTimeout;
        const random = options.random || Math.random;
        const spacing = 60;
        const maxInFlight = 8;
        const maxRetries = 5;
        const pending = new Set();
        let connected = false;
        let paused = false;
        let inFlight = 0;
        let lastSentAt = -Infinity;
        let timer = null;

        function getState() {
            const queuedByName = new Map();
            const pendingNames = new Set();
            let queuedCount = 0;
            for (const click of pending) {
                pendingNames.add(click.name);
                // Firebase already projects in-flight writes locally. Only add
                // clicks that have not yet been handed to the SDK to the UI.
                if (click.state === 'queued') {
                    queuedCount++;
                    queuedByName.set(click.name, (queuedByName.get(click.name) || 0) + 1);
                }
            }
            return { connected, paused, inFlight, pendingCount: pending.size,
                queuedCount, queuedByName, pendingNames };
        }

        function notify() { onChange(getState()); }

        function cancelTimer() {
            if (timer !== null) clearTimer(timer);
            timer = null;
        }

        function finish(click, error) {
            inFlight--;
            if (error) {
                click.state = 'queued';
                click.failures++;
                // All sends, including retries, pass through the same pacer.
                // Jitter also helps two tabs using the same nickname recover.
                click.readyAt = now() + Math.min(spacing * 2 ** (click.failures - 1), 2000)
                    + Math.floor(random() * 30);
                if (click.failures > maxRetries) paused = true;
            } else {
                pending.delete(click);
            }
            notify();
            pump();
        }

        function pump() {
            cancelTimer();
            if (!connected || paused || inFlight >= maxInFlight) return;

            let next = null;
            for (const click of pending) {
                if (click.state === 'queued' && (!next || click.readyAt < next.readyAt)) next = click;
            }
            if (!next) return;

            const delay = Math.max(next.readyAt, lastSentAt + spacing) - now();
            if (delay > 0) {
                timer = setTimer(pump, delay);
                return;
            }

            next.state = 'inFlight';
            inFlight++;
            lastSentAt = now();
            let result;
            try {
                // SDK local events can fire synchronously here. Remove the
                // queued UI projection before invoking the write, not after.
                result = write(next.name);
            } catch (error) {
                result = Promise.reject(error);
            }
            notify();
            // A slow/offline write stays in flight until Firebase settles it.
            // Never resend on a timeout: the original might have committed.
            Promise.resolve(result).then(() => finish(next, null), error => finish(next, error));
            pump();
        }

        function retry() {
            paused = false;
            for (const click of pending) {
                if (click.state === 'queued') {
                    click.failures = 0;
                    click.readyAt = now();
                }
            }
            notify();
            pump();
        }

        return {
            getState,
            enqueue(name) {
                pending.add({ name, state: 'queued', failures: 0, readyAt: now() });
                notify();
                pump();
            },
            setConnected(value) {
                const reconnected = !connected && value;
                connected = value;
                if (reconnected && paused) retry();
                else { notify(); pump(); }
            },
            retry
        };
    }

    if (typeof module === 'object' && module.exports) module.exports = { createClickSync };
    else root.createClickSync = createClickSync;
})(typeof globalThis !== 'undefined' ? globalThis : window);
