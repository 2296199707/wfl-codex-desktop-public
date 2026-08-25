import assert from "node:assert/strict";

const DEFAULT_SEED = 0x0c141517;
const DEFAULT_SEED_RUNS = 512;
const DEFAULT_EVENT_BYTES = 1_024;

class InjectedCrash extends Error {
  constructor(point, committed = false) {
    super(`injected crash at ${point}`);
    this.name = "InjectedCrash";
    this.point = point;
    this.committed = committed;
  }
}

class ReferenceEventStore {
  constructor({
    eventLogGeneration = "log-generation-1",
    runtimeEpoch = "runtime-epoch-1",
    maxEventBytes = DEFAULT_EVENT_BYTES,
  } = {}) {
    this.eventLogGeneration = eventLogGeneration;
    this.runtimeEpoch = runtimeEpoch;
    this.maxEventBytes = maxEventBytes;
    this.cursor = 0;
    this.rows = [];
    this.sourceToCursor = new Map();
    this.canonicalMappings = new Map();
    this.taskStates = new Map();
    this.controlSequence = 0;
  }

  setRuntimeEpoch(runtimeEpoch) {
    this.runtimeEpoch = runtimeEpoch;
  }

  rebuildEventLog(eventLogGeneration) {
    this.eventLogGeneration = eventLogGeneration;
    this.cursor = 0;
    this.rows = [];
    this.sourceToCursor = new Map();
    this.canonicalMappings = new Map();
    this.taskStates = new Map();
  }

  ingestNotification(notification, {
    crashAt = null,
    recipients = [],
  } = {}) {
    assert.equal(notification.runtimeEpoch, this.runtimeEpoch);
    assert.ok(Number.isSafeInteger(notification.upstreamEventSequence));
    assert.ok(notification.upstreamEventSequence > 0);
    const sourceId = [
      "upstream",
      notification.runtimeEpoch,
      notification.upstreamEventSequence,
    ].join(":");
    return this.#append({
      sourceId,
      sourceKind: "upstream",
      threadId: notification.threadId,
      canonicalEntityRef: notification.canonicalEntityRef,
      taskId: notification.taskId,
      taskState: notification.taskState,
      payloadBytes: notification.payloadBytes ?? 0,
      compressible: notification.compressible === true,
      runtimeEpoch: notification.runtimeEpoch,
      upstreamEventSequence: notification.upstreamEventSequence,
    }, { crashAt, recipients });
  }

  appendSubscriptionBarrier({
    windowInstanceId,
    nextObservedThreads,
    baseCursor,
    recipients = [],
  }) {
    this.controlSequence += 1;
    return this.#append({
      sourceId: `control:subscription:${this.controlSequence}`,
      sourceKind: "control",
      rowKind: "subscriptionBarrier",
      threadId: null,
      canonicalEntityRef: `subscription:${windowInstanceId}:${this.controlSequence}`,
      payloadBytes: 0,
      compressible: false,
      runtimeEpoch: this.runtimeEpoch,
      control: {
        windowInstanceId,
        baseCursor,
        nextObservedThreads: [...nextObservedThreads].sort(),
      },
    }, { recipients });
  }

  #append(input, {
    crashAt,
    recipients,
  }) {
    const existingCursor = this.sourceToCursor.get(input.sourceId);
    if (existingCursor !== undefined) {
      return {
        duplicate: true,
        row: this.rows[existingCursor - 1],
      };
    }

    this.#crash(crashAt, "before-append", false);

    const draft = {
      cursor: this.cursor,
      rows: [...this.rows],
      sourceToCursor: new Map(this.sourceToCursor),
      canonicalMappings: new Map(this.canonicalMappings),
      taskStates: new Map(this.taskStates),
    };
    const eventCursor = draft.cursor + 1;
    const oversized = (
      input.payloadBytes > this.maxEventBytes
      && input.compressible !== true
      && input.rowKind !== "subscriptionBarrier"
    );
    const rowKind = oversized
      ? "calibrationRequired"
      : (input.rowKind ?? "event");
    const row = Object.freeze({
      eventLogGeneration: this.eventLogGeneration,
      eventCursor,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      runtimeEpoch: input.runtimeEpoch,
      upstreamEventSequence: input.upstreamEventSequence ?? null,
      rowKind,
      threadId: input.threadId,
      canonicalEntityRef: input.canonicalEntityRef,
      taskId: input.taskId ?? null,
      taskState: input.taskState ?? null,
      payloadBytes: input.payloadBytes,
      sealedPayloadToken: rowKind === "event"
        ? `sealed:${input.sourceId}:${input.payloadBytes}`
        : null,
      barrierReason: oversized ? "event-over-record-budget" : null,
      control: input.control ?? null,
    });

    draft.cursor = eventCursor;
    draft.rows.push(row);
    this.#crash(crashAt, "after-append", false);

    draft.sourceToCursor.set(input.sourceId, eventCursor);
    if (input.canonicalEntityRef) {
      draft.canonicalMappings.set(input.sourceId, input.canonicalEntityRef);
    }
    if (input.taskId && input.taskState) {
      draft.taskStates.set(input.taskId, input.taskState);
    }
    this.#crash(crashAt, "after-state", false);

    this.cursor = draft.cursor;
    this.rows = draft.rows;
    this.sourceToCursor = draft.sourceToCursor;
    this.canonicalMappings = draft.canonicalMappings;
    this.taskStates = draft.taskStates;
    this.#crash(crashAt, "after-commit", true);

    for (let index = 0; index < recipients.length; index += 1) {
      const client = recipients[index];
      client.receive(this.envelopeFor(row, client.observedThreads));
      if (index === 0) {
        this.#crash(crashAt, "after-first-broadcast", true);
      }
    }

    return { duplicate: false, row };
  }

  #crash(configuredPoint, currentPoint, committed) {
    if (configuredPoint === currentPoint) {
      throw new InjectedCrash(currentPoint, committed);
    }
  }

  envelopeFor(row, observedThreads) {
    if (row.rowKind === "subscriptionBarrier") {
      return {
        eventLogGeneration: row.eventLogGeneration,
        eventCursor: row.eventCursor,
        deliveryKind: "barrier",
        barrierKind: "subscriptionBarrier",
        control: row.control,
      };
    }
    if (row.rowKind === "calibrationRequired") {
      return {
        eventLogGeneration: row.eventLogGeneration,
        eventCursor: row.eventCursor,
        deliveryKind: "barrier",
        barrierKind: "calibrationRequired",
        canonicalEntityRef: row.canonicalEntityRef,
        reason: row.barrierReason,
      };
    }
    if (!observedThreads.has(row.threadId)) {
      return {
        eventLogGeneration: row.eventLogGeneration,
        eventCursor: row.eventCursor,
        deliveryKind: "skip",
      };
    }
    return {
      eventLogGeneration: row.eventLogGeneration,
      eventCursor: row.eventCursor,
      deliveryKind: "full",
      threadId: row.threadId,
      canonicalEntityRef: row.canonicalEntityRef,
      sealedPayloadToken: row.sealedPayloadToken,
      payloadBytes: row.payloadBytes,
    };
  }

  deliverRange(client, {
    fromCursor = client.appliedCursor + 1,
    toCursor = this.cursor,
    observedThreads = client.observedThreads,
  } = {}) {
    if (toCursor < fromCursor) return [];
    const delivered = [];
    for (let cursor = fromCursor; cursor <= toCursor; cursor += 1) {
      const row = this.rows[cursor - 1];
      assert.ok(row, `event cursor ${cursor} must still be retained`);
      const envelope = this.envelopeFor(row, observedThreads);
      client.receive(envelope);
      delivered.push(envelope);
    }
    return delivered;
  }

  calibrationAt({
    baseCursor,
    fenceCursor,
    observedThreads,
    runtimeEpoch,
    eventLogGeneration,
  }) {
    assert.equal(eventLogGeneration, this.eventLogGeneration);
    assert.equal(runtimeEpoch, this.runtimeEpoch);
    assert.ok(baseCursor <= fenceCursor);
    assert.ok(fenceCursor <= this.cursor);
    return {
      eventLogGeneration,
      runtimeEpoch,
      baseCursor,
      fenceCursor,
      entities: this.rows
        .filter((row) => (
          row.eventCursor <= fenceCursor
          && row.rowKind === "event"
          && observedThreads.has(row.threadId)
        ))
        .map((row) => ({
          canonicalEntityRef: row.canonicalEntityRef,
          threadId: row.threadId,
        })),
    };
  }

  changeSubscription(client, nextObservedThreads, {
    duringSnapshot = null,
    afterFenceBeforeActivation = null,
  } = {}) {
    const phases = [];
    const previousObservedThreads = new Set(client.observedThreads);
    const baseCursor = client.appliedCursor;
    const calibrationGeneration = this.eventLogGeneration;
    const calibrationEpoch = this.runtimeEpoch;
    phases.push("snapshot-started");

    duringSnapshot?.();
    if (
      this.eventLogGeneration !== calibrationGeneration
      || this.runtimeEpoch !== calibrationEpoch
    ) {
      phases.push("snapshot-discarded");
      return { status: "stale", phases };
    }
    phases.push("snapshot-ready");

    const barrier = this.appendSubscriptionBarrier({
      windowInstanceId: client.windowInstanceId,
      nextObservedThreads,
      baseCursor,
    }).row;
    const fenceCursor = barrier.eventCursor;
    phases.push("barrier-committed");

    this.deliverRange(client, {
      fromCursor: baseCursor + 1,
      toCursor: fenceCursor,
      observedThreads: previousObservedThreads,
    });
    phases.push("old-observation-through-fence");
    client.persistCheckpoint();
    phases.push("checkpoint-and-ack-durable");

    const calibration = this.calibrationAt({
      baseCursor,
      fenceCursor,
      observedThreads: nextObservedThreads,
      runtimeEpoch: calibrationEpoch,
      eventLogGeneration: calibrationGeneration,
    });

    afterFenceBeforeActivation?.();
    if (
      this.eventLogGeneration !== calibrationGeneration
      || this.runtimeEpoch !== calibrationEpoch
    ) {
      phases.push("calibration-discarded");
      return {
        status: "stale",
        barrier,
        fenceCursor,
        phases,
      };
    }

    client.applyCalibration(calibration);
    phases.push("calibration-applied");
    client.observedThreads = new Set(nextObservedThreads);
    phases.push("new-observation-activated");
    this.deliverRange(client, {
      fromCursor: fenceCursor + 1,
      toCursor: this.cursor,
      observedThreads: client.observedThreads,
    });
    phases.push("post-fence-delivered");
    return {
      status: "activated",
      barrier,
      calibration,
      fenceCursor,
      phases,
    };
  }
}

class ReferenceClient {
  constructor({
    windowInstanceId,
    observedThreads = [],
    eventLogGeneration = "log-generation-1",
    seedCursor = 0,
  }) {
    this.windowInstanceId = windowInstanceId;
    this.observedThreads = new Set(observedThreads);
    this.eventLogGeneration = eventLogGeneration;
    this.appliedCursor = seedCursor;
    this.durableCursor = seedCursor;
    this.envelopes = [];
    this.duplicateDeliveries = 0;
    this.calibratedEntities = new Map();
    this.checkpoint = null;
  }

  receive(envelope) {
    assert.equal(envelope.eventLogGeneration, this.eventLogGeneration);
    if (envelope.eventCursor <= this.appliedCursor) {
      this.duplicateDeliveries += 1;
      return;
    }
    assert.equal(
      envelope.eventCursor,
      this.appliedCursor + 1,
      "a window may apply only a continuous account cursor",
    );
    if (envelope.deliveryKind === "skip") {
      assert.deepEqual(Object.keys(envelope).sort(), [
        "deliveryKind",
        "eventCursor",
        "eventLogGeneration",
      ]);
    }
    this.envelopes.push(envelope);
    this.appliedCursor = envelope.eventCursor;
  }

  persistCheckpoint() {
    this.durableCursor = this.appliedCursor;
    this.checkpoint = Object.freeze({
      checkpointId: `checkpoint:${this.windowInstanceId}:${this.durableCursor}`,
      accountId: "account-1",
      schemaVersion: 1,
      eventLogGeneration: this.eventLogGeneration,
      eventCursor: this.durableCursor,
    });
    return this.checkpoint;
  }

  applyCalibration(calibration) {
    assert.equal(calibration.eventLogGeneration, this.eventLogGeneration);
    assert.equal(calibration.fenceCursor, this.durableCursor);
    for (const entity of calibration.entities) {
      this.calibratedEntities.set(entity.canonicalEntityRef, entity);
    }
  }
}

class ReferenceWindowRegistry {
  constructor({
    eventLogGeneration,
    retainedCursor,
    now = 1_000,
    leaseDuration = 500,
  }) {
    this.eventLogGeneration = eventLogGeneration;
    this.retainedCursor = retainedCursor;
    this.now = now;
    this.leaseDuration = leaseDuration;
    this.nextWindowId = 1;
    this.leases = new Map();
  }

  registerDocument({
    accountId,
    clientInstanceId,
    windowNonce,
    presentedWindowInstanceId = null,
    checkpoint = null,
  }) {
    const presented = presentedWindowInstanceId
      ? this.leases.get(presentedWindowInstanceId)
      : null;
    if (
      presented
      && presented.expiresAt > this.now
      && presented.accountId === accountId
      && presented.clientInstanceId === clientInstanceId
      && presented.windowNonce === windowNonce
    ) {
      presented.expiresAt = this.now + this.leaseDuration;
      return {
        windowInstanceId: presented.windowInstanceId,
        seedCursor: presented.ackCursor,
        sameDocumentReconnect: true,
        resyncRequired: false,
      };
    }

    const checkpointIsCompatible = Boolean(
      checkpoint
      && checkpoint.accountId === accountId
      && checkpoint.schemaVersion === 1
      && checkpoint.eventLogGeneration === this.eventLogGeneration
      && Number.isSafeInteger(checkpoint.eventCursor)
      && checkpoint.eventCursor >= 0
      && checkpoint.eventCursor <= this.retainedCursor,
    );
    const windowInstanceId = `window-${this.nextWindowId++}`;
    const lease = {
      windowInstanceId,
      accountId,
      clientInstanceId,
      windowNonce,
      ackCursor: checkpointIsCompatible ? checkpoint.eventCursor : 0,
      expiresAt: this.now + this.leaseDuration,
    };
    this.leases.set(windowInstanceId, lease);
    return {
      windowInstanceId,
      seedCursor: lease.ackCursor,
      sameDocumentReconnect: false,
      replacedPresentedWindow: Boolean(presentedWindowInstanceId),
      resyncRequired: Boolean(checkpoint) && !checkpointIsCompatible,
    };
  }

  acknowledge(windowInstanceId, eventLogGeneration, eventCursor) {
    const lease = this.leases.get(windowInstanceId);
    assert.ok(lease);
    assert.equal(eventLogGeneration, this.eventLogGeneration);
    assert.ok(eventCursor >= lease.ackCursor);
    assert.ok(eventCursor <= this.retainedCursor);
    lease.ackCursor = eventCursor;
    lease.expiresAt = this.now + this.leaseDuration;
  }

  advanceTime(milliseconds) {
    this.now += milliseconds;
    for (const [windowInstanceId, lease] of this.leases) {
      if (lease.expiresAt <= this.now) {
        this.leases.delete(windowInstanceId);
      }
    }
  }
}

function upstreamEvent({
  epoch,
  sequence,
  threadId,
  entity,
  taskId = `task:${threadId}`,
  taskState = "inProgress",
  payloadBytes = 64,
  compressible = false,
}) {
  return {
    runtimeEpoch: epoch,
    upstreamEventSequence: sequence,
    threadId,
    canonicalEntityRef: entity,
    taskId,
    taskState,
    payloadBytes,
    compressible,
  };
}

function verifyC14() {
  const store = new ReferenceEventStore({
    runtimeEpoch: "epoch-before-restart",
  });
  const client = new ReferenceClient({
    windowInstanceId: "window-c14",
    observedThreads: ["thread-a"],
  });
  store.ingestNotification(upstreamEvent({
    epoch: "epoch-before-restart",
    sequence: 97,
    threadId: "thread-a",
    entity: "item-a-1",
  }), { recipients: [client] });
  store.ingestNotification(upstreamEvent({
    epoch: "epoch-before-restart",
    sequence: 98,
    threadId: "thread-a",
    entity: "item-a-2",
  }), { recipients: [client] });
  client.persistCheckpoint();

  store.setRuntimeEpoch("epoch-after-restart");
  const afterRestart = upstreamEvent({
    epoch: "epoch-after-restart",
    sequence: 1,
    threadId: "thread-a",
    entity: "item-a-3",
    taskState: "completed",
  });
  store.ingestNotification(afterRestart, { recipients: [client] });
  const cursorBeforeDuplicate = store.cursor;
  const duplicate = store.ingestNotification(afterRestart);
  client.persistCheckpoint();

  assert.equal(duplicate.duplicate, true);
  assert.equal(store.cursor, cursorBeforeDuplicate);
  assert.deepEqual(store.rows.map((row) => row.upstreamEventSequence), [97, 98, 1]);
  assert.deepEqual(store.rows.map((row) => row.eventCursor), [1, 2, 3]);
  assert.equal(new Set(store.rows.map((row) => row.sourceId)).size, 3);
  assert.equal(client.durableCursor, 3);
  return {
    upstreamSequences: [97, 98, 1],
    durableEventCursor: client.durableCursor,
    duplicateMappedToCursor: duplicate.row.eventCursor,
  };
}

function verifyC15() {
  const store = new ReferenceEventStore({ runtimeEpoch: "epoch-c15" });
  const client = new ReferenceClient({
    windowInstanceId: "window-c15",
    observedThreads: ["thread-a"],
  });
  store.ingestNotification(upstreamEvent({
    epoch: "epoch-c15",
    sequence: 1,
    threadId: "thread-a",
    entity: "a-1",
  }));
  store.ingestNotification(upstreamEvent({
    epoch: "epoch-c15",
    sequence: 2,
    threadId: "thread-b",
    entity: "b-1",
  }));
  store.ingestNotification(upstreamEvent({
    epoch: "epoch-c15",
    sequence: 3,
    threadId: "thread-a",
    entity: "a-2",
  }));
  store.deliverRange(client);

  let sequence = 3;
  const change = store.changeSubscription(
    client,
    new Set(["thread-a", "thread-b"]),
    {
      duringSnapshot() {
        sequence += 1;
        store.ingestNotification(upstreamEvent({
          epoch: "epoch-c15",
          sequence,
          threadId: "thread-b",
          entity: "b-before-fence",
        }));
      },
      afterFenceBeforeActivation() {
        sequence += 1;
        store.ingestNotification(upstreamEvent({
          epoch: "epoch-c15",
          sequence,
          threadId: "thread-b",
          entity: "b-after-fence",
        }));
      },
    },
  );

  assert.equal(change.status, "activated");
  assert.deepEqual(change.phases, [
    "snapshot-started",
    "snapshot-ready",
    "barrier-committed",
    "old-observation-through-fence",
    "checkpoint-and-ack-durable",
    "calibration-applied",
    "new-observation-activated",
    "post-fence-delivered",
  ]);
  assert.deepEqual(
    client.envelopes.map((envelope) => envelope.eventCursor),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    client.envelopes.map((envelope) => envelope.deliveryKind),
    ["full", "skip", "full", "skip", "barrier", "full"],
  );
  assert.equal(change.fenceCursor, 5);
  assert.equal(client.checkpoint.eventCursor, 5);
  assert.ok(client.calibratedEntities.has("b-1"));
  assert.ok(client.calibratedEntities.has("b-before-fence"));
  assert.equal(
    client.envelopes.at(-1).canonicalEntityRef,
    "b-after-fence",
  );

  const staleStore = new ReferenceEventStore({ runtimeEpoch: "epoch-stale-1" });
  const staleClient = new ReferenceClient({
    windowInstanceId: "window-c15-stale",
    observedThreads: ["thread-a"],
  });
  const stale = staleStore.changeSubscription(
    staleClient,
    new Set(["thread-a", "thread-b"]),
    {
      duringSnapshot() {
        staleStore.setRuntimeEpoch("epoch-stale-2");
      },
    },
  );
  assert.equal(stale.status, "stale");
  assert.deepEqual([...staleClient.observedThreads], ["thread-a"]);
  assert.equal(staleStore.cursor, 0);

  const postBarrierStore = new ReferenceEventStore({
    runtimeEpoch: "epoch-post-barrier-1",
  });
  const postBarrierClient = new ReferenceClient({
    windowInstanceId: "window-c15-post-barrier",
    observedThreads: ["thread-a"],
  });
  const postBarrierStale = postBarrierStore.changeSubscription(
    postBarrierClient,
    new Set(["thread-a", "thread-b"]),
    {
      afterFenceBeforeActivation() {
        postBarrierStore.setRuntimeEpoch("epoch-post-barrier-2");
      },
    },
  );
  assert.equal(postBarrierStale.status, "stale");
  assert.equal(postBarrierStale.fenceCursor, 1);
  assert.equal(postBarrierClient.durableCursor, 1);
  assert.deepEqual([...postBarrierClient.observedThreads], ["thread-a"]);
  assert.equal(
    postBarrierStale.phases.at(-1),
    "calibration-discarded",
  );
  const postBarrierRetry = postBarrierStore.changeSubscription(
    postBarrierClient,
    new Set(["thread-a", "thread-b"]),
  );
  assert.equal(postBarrierRetry.status, "activated");
  assert.equal(postBarrierRetry.fenceCursor, 2);
  assert.deepEqual(
    [...postBarrierClient.observedThreads],
    ["thread-a", "thread-b"],
  );

  return {
    deliveryKinds: client.envelopes.map((envelope) => envelope.deliveryKind),
    fenceCursor: change.fenceCursor,
    durableCursorAtCalibration: client.checkpoint.eventCursor,
    calibratedThreadBEntities: [...client.calibratedEntities.keys()]
      .filter((key) => key.startsWith("b-")).length,
    staleEpochCalibrationDiscarded: true,
    postBarrierEpochChangeRetriedAtNewFence: postBarrierRetry.fenceCursor,
  };
}

function verifyC16() {
  const registry = new ReferenceWindowRegistry({
    eventLogGeneration: "log-generation-1",
    retainedCursor: 12,
  });
  const first = registry.registerDocument({
    accountId: "account-1",
    clientInstanceId: "client-1",
    windowNonce: "nonce-document-1",
  });
  registry.acknowledge(
    first.windowInstanceId,
    "log-generation-1",
    8,
  );
  const checkpoint = Object.freeze({
    checkpointId: "checkpoint-document-1",
    accountId: "account-1",
    schemaVersion: 1,
    eventLogGeneration: "log-generation-1",
    eventCursor: 8,
  });

  const sameDocument = registry.registerDocument({
    accountId: "account-1",
    clientInstanceId: "client-1",
    windowNonce: "nonce-document-1",
    presentedWindowInstanceId: first.windowInstanceId,
    checkpoint,
  });
  assert.equal(sameDocument.windowInstanceId, first.windowInstanceId);
  assert.equal(sameDocument.sameDocumentReconnect, true);

  registry.advanceTime(300);
  const reloaded = registry.registerDocument({
    accountId: "account-1",
    clientInstanceId: "client-1",
    windowNonce: "nonce-document-2",
    presentedWindowInstanceId: first.windowInstanceId,
    checkpoint,
  });
  assert.notEqual(reloaded.windowInstanceId, first.windowInstanceId);
  assert.equal(reloaded.seedCursor, 8);
  assert.equal(reloaded.sameDocumentReconnect, false);
  assert.equal(registry.leases.get(first.windowInstanceId).ackCursor, 8);
  assert.equal(registry.leases.get(reloaded.windowInstanceId).ackCursor, 8);

  const incompatible = registry.registerDocument({
    accountId: "account-2",
    clientInstanceId: "client-2",
    windowNonce: "nonce-document-3",
    checkpoint,
  });
  assert.equal(incompatible.seedCursor, 0);
  assert.equal(incompatible.resyncRequired, true);

  const staleGeneration = registry.registerDocument({
    accountId: "account-1",
    clientInstanceId: "client-3",
    windowNonce: "nonce-document-4",
    checkpoint: {
      ...checkpoint,
      checkpointId: "checkpoint-old-generation",
      eventLogGeneration: "log-generation-old",
    },
  });
  assert.equal(staleGeneration.seedCursor, 0);
  assert.equal(staleGeneration.resyncRequired, true);

  registry.advanceTime(201);
  assert.equal(registry.leases.has(first.windowInstanceId), false);
  assert.equal(registry.leases.has(reloaded.windowInstanceId), true);
  registry.advanceTime(300);
  assert.equal(registry.leases.has(reloaded.windowInstanceId), false);

  return {
    sameDocumentWindow: sameDocument.windowInstanceId,
    reloadedWindow: reloaded.windowInstanceId,
    checkpointSeedCursor: reloaded.seedCursor,
    oldLeaseExpired: true,
    crossAccountCheckpointRejected: true,
    staleGenerationCheckpointRejected: true,
  };
}

function verifyC17() {
  const crashPoints = [
    "before-append",
    "after-append",
    "after-state",
    "after-commit",
    "after-first-broadcast",
  ];
  const crashResults = [];

  for (const crashPoint of crashPoints) {
    const store = new ReferenceEventStore({ runtimeEpoch: "epoch-c17" });
    const clients = [
      new ReferenceClient({
        windowInstanceId: `window-${crashPoint}-1`,
        observedThreads: ["thread-a"],
      }),
      new ReferenceClient({
        windowInstanceId: `window-${crashPoint}-2`,
        observedThreads: ["thread-a"],
      }),
    ];
    store.ingestNotification(upstreamEvent({
      epoch: "epoch-c17",
      sequence: 1,
      threadId: "thread-a",
      entity: "item-running",
      taskState: "inProgress",
    }), { recipients: clients });
    for (const client of clients) client.persistCheckpoint();

    const completed = upstreamEvent({
      epoch: "epoch-c17",
      sequence: 2,
      threadId: "thread-a",
      entity: "item-completed",
      taskState: "completed",
    });
    let crash = null;
    try {
      store.ingestNotification(completed, {
        crashAt: crashPoint,
        recipients: clients,
      });
      assert.fail(`crash point ${crashPoint} did not fire`);
    } catch (error) {
      assert.ok(error instanceof InjectedCrash);
      crash = error;
    }

    if (crash.committed) {
      assert.equal(store.cursor, 2);
      assert.equal(store.taskStates.get("task:thread-a"), "completed");
      assert.equal(store.sourceToCursor.get("upstream:epoch-c17:2"), 2);
    } else {
      assert.equal(store.cursor, 1);
      assert.equal(store.taskStates.get("task:thread-a"), "inProgress");
      assert.equal(store.sourceToCursor.has("upstream:epoch-c17:2"), false);
      assert.equal(clients[0].appliedCursor, 1);
      assert.equal(clients[1].appliedCursor, 1);
    }

    const retry = store.ingestNotification(completed, {
      recipients: crash.committed ? [] : clients,
    });
    assert.equal(retry.duplicate, crash.committed);
    for (const client of clients) {
      store.deliverRange(client, {
        fromCursor: client.durableCursor + 1,
      });
      client.persistCheckpoint();
      assert.equal(client.durableCursor, 2);
    }
    assert.equal(store.rows.length, 2);
    assert.deepEqual(store.rows.map((row) => row.eventCursor), [1, 2]);
    assert.equal(store.taskStates.get("task:thread-a"), "completed");
    assert.equal(store.sourceToCursor.get("upstream:epoch-c17:2"), 2);
    crashResults.push({
      crashPoint,
      committedBeforeRecovery: crash.committed,
      idempotentReplayDuplicatesIgnored: clients
        .reduce((total, client) => total + client.duplicateDeliveries, 0),
    });
  }

  const oversizedStore = new ReferenceEventStore({
    runtimeEpoch: "epoch-c17-large",
    maxEventBytes: 128,
  });
  const oversizedClient = new ReferenceClient({
    windowInstanceId: "window-c17-large",
    observedThreads: ["thread-large"],
  });
  const oversized = oversizedStore.ingestNotification(upstreamEvent({
    epoch: "epoch-c17-large",
    sequence: 1,
    threadId: "thread-large",
    entity: "turn-large:terminal-item",
    taskState: "completed",
    payloadBytes: 129,
    compressible: false,
  }), { recipients: [oversizedClient] }).row;
  assert.equal(oversized.rowKind, "calibrationRequired");
  assert.equal(oversized.sealedPayloadToken, null);
  assert.equal(oversized.barrierReason, "event-over-record-budget");
  assert.equal(oversizedStore.taskStates.get("task:thread-large"), "completed");
  assert.equal(oversizedClient.envelopes[0].deliveryKind, "barrier");
  assert.equal(oversizedClient.envelopes[0].barrierKind, "calibrationRequired");
  assert.equal(
    oversizedClient.envelopes[0].canonicalEntityRef,
    "turn-large:terminal-item",
  );

  return {
    crashPoints: crashResults,
    oversizedEvent: {
      inputBytes: 129,
      storedKind: oversized.rowKind,
      payloadStored: oversized.sealedPayloadToken !== null,
      taskState: oversizedStore.taskStates.get("task:thread-large"),
      deliveryKind: oversizedClient.envelopes[0].deliveryKind,
    },
  };
}

function createPrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function verifySeed(seed) {
  const random = createPrng(seed);
  const store = new ReferenceEventStore({
    runtimeEpoch: "epoch-random-1",
    maxEventBytes: 256,
  });
  const observedThreads = new Set(["thread-0", "thread-2"]);
  const client = new ReferenceClient({
    windowInstanceId: `window-seed-${seed}`,
    observedThreads,
  });
  const threads = ["thread-0", "thread-1", "thread-2", "thread-3"];
  let epochNumber = 1;
  let upstreamSequence = 0;
  const eventCount = 24 + Math.floor(random() * 24);

  for (let index = 0; index < eventCount; index += 1) {
    if (index > 0 && random() < 0.14) {
      epochNumber += 1;
      upstreamSequence = 0;
      store.setRuntimeEpoch(`epoch-random-${epochNumber}`);
    }
    upstreamSequence += 1;
    const threadId = threads[Math.floor(random() * threads.length)];
    const oversized = random() < 0.08;
    const event = upstreamEvent({
      epoch: store.runtimeEpoch,
      sequence: upstreamSequence,
      threadId,
      entity: `entity-${index}`,
      taskState: random() < 0.2 ? "completed" : "inProgress",
      payloadBytes: oversized ? 300 : 16 + Math.floor(random() * 128),
      compressible: false,
    });
    const result = store.ingestNotification(event);
    assert.equal(result.duplicate, false);
    if (random() < 0.18) {
      const duplicateCursor = store.cursor;
      const duplicate = store.ingestNotification(event);
      assert.equal(duplicate.duplicate, true);
      assert.equal(store.cursor, duplicateCursor);
    }
  }

  store.deliverRange(client);
  client.persistCheckpoint();
  assert.deepEqual(
    store.rows.map((row) => row.eventCursor),
    Array.from({ length: store.cursor }, (_, index) => index + 1),
  );
  assert.equal(store.sourceToCursor.size, store.rows.length);
  assert.deepEqual(
    client.envelopes.map((envelope) => envelope.eventCursor),
    Array.from({ length: store.cursor }, (_, index) => index + 1),
  );
  for (const [index, row] of store.rows.entries()) {
    const envelope = client.envelopes[index];
    if (row.rowKind === "calibrationRequired") {
      assert.equal(envelope.deliveryKind, "barrier");
    } else if (observedThreads.has(row.threadId)) {
      assert.equal(envelope.deliveryKind, "full");
    } else {
      assert.equal(envelope.deliveryKind, "skip");
      assert.equal("threadId" in envelope, false);
      assert.equal("sealedPayloadToken" in envelope, false);
    }
  }
  return {
    events: store.rows.length,
    epochs: epochNumber,
    barriers: store.rows.filter((row) => row.rowKind !== "event").length,
  };
}

function parseArguments(argv) {
  const options = {
    seed: DEFAULT_SEED,
    seedRuns: DEFAULT_SEED_RUNS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--seed") {
      options.seed = Number(argv[++index]);
    } else if (argument === "--seed-runs") {
      options.seedRuns = Number(argv[++index]);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  assert.ok(Number.isSafeInteger(options.seed));
  assert.ok(options.seed >= 0 && options.seed <= 0xffff_ffff);
  assert.ok(Number.isSafeInteger(options.seedRuns));
  assert.ok(options.seedRuns > 0 && options.seedRuns <= 10_000);
  return options;
}

const options = parseArguments(process.argv.slice(2));
const c14 = verifyC14();
const c15 = verifyC15();
const c16 = verifyC16();
const c17 = verifyC17();
const seededRuns = [];
for (let offset = 0; offset < options.seedRuns; offset += 1) {
  seededRuns.push(verifySeed((options.seed + offset) >>> 0));
}

console.log(JSON.stringify({
  ok: true,
  model: "conversation-event-log-reference",
  productionCodeExercised: false,
  networkAccessed: false,
  rescueWindowAccessed: false,
  seed: options.seed,
  seedRuns: options.seedRuns,
  aggregate: {
    events: seededRuns.reduce((total, run) => total + run.events, 0),
    epochGenerations: seededRuns.reduce((total, run) => total + run.epochs, 0),
    calibrationBarriers: seededRuns.reduce((total, run) => total + run.barriers, 0),
  },
  scenarios: {
    C14: c14,
    C15: c15,
    C16: c16,
    C17: c17,
  },
}, null, 2));
