export type ActiveWorkKind =
    | "startup-decay"
    | "decay"
    | "prune"
    | "query-hit"
    | "reflection"
    | "user-summary"
    | "telemetry"
    | string;

type ActiveEntry = {
    id: number;
    kind: ActiveWorkKind;
    promise: Promise<unknown>;
};

export type ActiveWorkSnapshot = {
    frozen: boolean;
    active: number;
    generation: number;
    by_kind: Record<string, number>;
    lifecycle_errors: string[];
};

const active = new Map<number, ActiveEntry>();
const lifecycle_errors: Error[] = [];
let frozen = false;
let generation = 0;
let next_id = 1;

const as_error = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));

export const track_active_work = <T>(
    kind: ActiveWorkKind,
    work: Promise<T>,
): Promise<T> => {
    if (frozen) {
        const error = new Error(
            `ACTIVE_WORK_FROZEN: refused late registration for ${kind}`,
        );
        lifecycle_errors.push(error);
        generation++;
        throw error;
    }

    const id = next_id++;
    let observed: Promise<T>;
    observed = Promise.resolve(work)
        .catch((error) => {
            const normalized = as_error(error);
            lifecycle_errors.push(normalized);
            throw normalized;
        })
        .finally(() => {
            active.delete(id);
            generation++;
        });
    active.set(id, { id, kind, promise: observed });
    generation++;
    return observed;
};

export const freeze_active_work = (): void => {
    frozen = true;
    generation++;
};

export const join_active_work = async (
    deadline_at: number = Number.POSITIVE_INFINITY,
): Promise<void> => {
    for (;;) {
        if (Date.now() >= deadline_at) {
            throw new Error("ACTIVE_WORK_JOIN_TIMEOUT");
        }
        const before = generation;
        const snapshot = [...active.values()].map((entry) => entry.promise);
        if (snapshot.length > 0) {
            const remaining = deadline_at - Date.now();
            await Promise.race([
                Promise.allSettled(snapshot),
                new Promise<never>((_, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error("ACTIVE_WORK_JOIN_TIMEOUT")),
                        Math.max(1, remaining),
                    );
                    timer.unref?.();
                }),
            ]);
            continue;
        }

        await Promise.resolve();
        if (active.size === 0 && generation === before) return;
    }
};

export const active_work_snapshot = (): ActiveWorkSnapshot => {
    const by_kind: Record<string, number> = {};
    for (const entry of active.values()) {
        by_kind[entry.kind] = (by_kind[entry.kind] || 0) + 1;
    }
    return {
        frozen,
        active: active.size,
        generation,
        by_kind,
        lifecycle_errors: lifecycle_errors.map((error) => error.message),
    };
};

export const active_work_errors = (): readonly Error[] => lifecycle_errors;

export const reset_active_work_for_tests = (): void => {
    if (active.size !== 0) {
        throw new Error("ACTIVE_WORK_RESET_WITH_LIVE_ENTRIES");
    }
    frozen = false;
    lifecycle_errors.length = 0;
    generation = 0;
    next_id = 1;
};
