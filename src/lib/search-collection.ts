export interface SearchPageTaskResult<T> {
  items: T[];
  retryable?: boolean;
  error?: string;
}

export interface CollectPagedSearchResultsOptions<T> {
  targetCount: number;
  maxPages: number;
  maxPageRetries: number;
  emptyRoundsBeforeStop: number;
  keyFn: (item: T) => string;
  getPage: (page: number, attempt: number) => Promise<SearchPageTaskResult<T>[] | null>;
  sleep?: (ms: number) => Promise<void>;
  onPage?: (info: {
    page: number;
    attempt: number;
    added: number;
    total: number;
    retryableFailures: number;
    hardFailures: number;
  }) => void;
}

export interface CollectPagedSearchResultsResult<T> {
  items: T[];
  sawRetryableFailure: boolean;
}

export async function collectPagedSearchResults<T>(
  options: CollectPagedSearchResultsOptions<T>
): Promise<CollectPagedSearchResultsResult<T>> {
  const {
    targetCount,
    maxPages,
    maxPageRetries,
    emptyRoundsBeforeStop,
    keyFn,
    getPage,
    sleep = async () => {},
    onPage,
  } = options;

  const seen = new Set<string>();
  const items: T[] = [];
  let exhaustedRounds = 0;
  let sawRetryableFailure = false;

  outer:
  for (let page = 0; page < maxPages && items.length < targetCount; page += 1) {
    let pageSettled = false;

    for (let attempt = 0; attempt <= maxPageRetries && !pageSettled; attempt += 1) {
      const outcomes = await getPage(page, attempt);
      if (outcomes == null) break outer;

      const pageItems = outcomes.flatMap((outcome) => outcome.items);
      const retryableFailures = outcomes.filter((outcome) => outcome.retryable);
      const hardFailures = outcomes.filter((outcome) => outcome.error && !outcome.retryable);

      let added = 0;
      for (const item of pageItems) {
        const key = keyFn(item);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        added += 1;
      }

      if (retryableFailures.length > 0) {
        sawRetryableFailure = true;
      }

      onPage?.({
        page,
        attempt,
        added,
        total: items.length,
        retryableFailures: retryableFailures.length,
        hardFailures: hardFailures.length,
      });

      const shouldRetrySamePage =
        retryableFailures.length > 0 &&
        pageItems.length === 0 &&
        attempt < maxPageRetries;

      if (shouldRetrySamePage) {
        const waitMs = Math.min(1500 * 2 ** attempt, 8000);
        await sleep(waitMs);
        continue;
      }

      pageSettled = true;

      if (pageItems.length === 0 && retryableFailures.length === 0) {
        exhaustedRounds += 1;
        if (exhaustedRounds >= emptyRoundsBeforeStop) {
          break outer;
        }
      } else {
        exhaustedRounds = 0;
      }
    }
  }

  return { items, sawRetryableFailure };
}
