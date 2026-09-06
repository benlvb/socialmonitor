/**
 * Minimal ambient types for `google-play-scraper` (no bundled types). Only the
 * surface the public Play transport uses; shapes verified against v10.1.3 output.
 */
declare module "google-play-scraper" {
  export interface GplayReview {
    id: string;
    userName?: string;
    userImage?: string;
    date: string; // ISO with milliseconds
    score?: number;
    scoreText?: string;
    url?: string;
    title?: string | null;
    text?: string | null;
    replyDate?: string | null;
    replyText?: string | null;
    version?: string | null;
    thumbsUp?: number;
  }
  export interface ReviewsResult {
    data: GplayReview[];
    nextPaginationToken?: string | null;
  }
  export interface ReviewsOptions {
    appId: string;
    lang?: string;
    country?: string;
    sort?: number;
    num?: number;
    paginate?: boolean;
    nextPaginationToken?: string | null;
    throttle?: number;
  }
  export interface AppOptions {
    appId: string;
    lang?: string;
    country?: string;
    throttle?: number;
  }
  export interface AppResult {
    title?: string;
    developer?: string;
    score?: number;
    ratings?: number;
    reviews?: number;
  }
  export interface Gplay {
    reviews(options: ReviewsOptions): Promise<ReviewsResult>;
    app(options: AppOptions): Promise<AppResult>;
    sort: { NEWEST: number; RATING: number; HELPFULNESS: number };
  }
  const gplay: Gplay;
  export default gplay;
}
