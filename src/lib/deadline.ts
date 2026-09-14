import { FetchError } from "@/lib/errors";
import { DEADLINE_GRACE_MS } from "@/lib/timing";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 処理フェーズ全体の制限時間 */
export class Deadline {
  private readonly startedAt = Date.now();

  constructor(readonly budgetMs: number) {}

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  remaining(): number {
    return Math.max(0, this.budgetMs - this.elapsed());
  }

  /**
   * 制限時間(+猶予)を過ぎても promise が終わらなければ、deadline の FetchError で打ち切る。
   * 各リクエストは残り時間に合わせてタイムアウトを縮めるので通常はそちらが先に終わる。これは保険。
   */
  race<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new FetchError(label, { kind: "deadline", attempts: 0, elapsedMs: this.elapsed(), stoppedByDeadline: true })),
        this.remaining() + DEADLINE_GRACE_MS,
      );
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  }
}
