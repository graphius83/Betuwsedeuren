// api/reviews.ts
//
// Vercel Serverless Function that proxies the Google Places API (New)
// so the API key never reaches the browser, and caches results so a
// busy site doesn't burn through Google's quota / your free credit.
//
// Setup:
// 1. Deploy this in a Vercel project at the path `api/reviews.ts`
//    (Vercel auto-detects anything under /api as a serverless function).
// 2. In the Vercel project settings, add environment variables:
//      GOOGLE_PLACES_API_KEY = <your restricted API key>
//      GOOGLE_PLACE_ID       = <the Place ID for the business>
//      ALLOWED_ORIGIN        = <your Framer site's domain, e.g. https://mysite.com>
// 3. Deploy. Your endpoint will be:
//      https://<your-vercel-project>.vercel.app/api/reviews
//    Use that as the `apiUrl` prop in the Framer GoogleReviews component.

export const config = {
  runtime: "edge",
}

interface GooglePlacesReview {
  authorAttribution?: {
    displayName?: string
    photoUri?: string
  }
  rating?: number
  text?: {
    text?: string
  }
  relativePublishTimeDescription?: string
  publishTime?: string
}

interface GooglePlacesResponse {
  rating?: number
  userRatingCount?: number
  reviews?: GooglePlacesReview[]
}

interface NormalizedReview {
  author_name: string
  rating: number
  text: string
  relative_time_description: string
  time: number
  profile_photo_url: string
}

interface NormalizedPayload {
  reviews: NormalizedReview[]
  overall_rating: number
  total_reviews: number
}

// Simple in-memory cache. Note: on Vercel Edge this persists per-instance,
// not globally — combined with the Cache-Control header below, this keeps
// actual Google API calls very low even without an external cache like
// Redis. Good enough for ~1000 sessions/month; revisit if you scale up.
let cache: { data: NormalizedPayload; fetchedAt: number } | null = null
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour — adjust as needed

function normalize(raw: GooglePlacesResponse): NormalizedPayload {
  const reviews: NormalizedReview[] = (raw.reviews ?? []).map((r) => ({
    author_name: r.authorAttribution?.displayName ?? "Anonymous",
    rating: typeof r.rating === "number" ? r.rating : 0,
    text: r.text?.text ?? "",
    relative_time_description: r.relativePublishTimeDescription ?? "",
    time: r.publishTime ? new Date(r.publishTime).getTime() / 1000 : 0,
    profile_photo_url: r.authorAttribution?.photoUri ?? "",
  }))

  return {
    reviews,
    overall_rating: typeof raw.rating === "number" ? raw.rating : 0,
    total_reviews:
      typeof raw.userRatingCount === "number" ? raw.userRatingCount : 0,
  }
}

function corsHeaders(): HeadersInit {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*"
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    // Also let browsers/CDNs cache the response for a while.
    "Cache-Control": "public, max-age=300, s-maxage=3600",
  }
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: corsHeaders(),
    })
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  const placeId = process.env.GOOGLE_PLACE_ID

  if (!apiKey || !placeId) {
    return new Response(
      JSON.stringify({
        error: "Server misconfigured: missing API key or Place ID",
      }),
      { status: 500, headers: corsHeaders() }
    )
  }

  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return new Response(JSON.stringify(cache.data), {
      status: 200,
      headers: corsHeaders(),
    })
  }

  try {
    const fieldMask = "rating,userRatingCount,reviews"
    const googleUrl = `https://places.googleapis.com/v1/places/${placeId}`

    const googleResponse = await fetch(googleUrl, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
    })

    if (!googleResponse.ok) {
      const errorBody = await googleResponse.text()
      throw new Error(
        `Google Places API error (${googleResponse.status}): ${errorBody}`
      )
    }

    const raw: GooglePlacesResponse = await googleResponse.json()
    const normalized = normalize(raw)

    cache = { data: normalized, fetchedAt: now }

    return new Response(JSON.stringify(normalized), {
      status: 200,
      headers: corsHeaders(),
    })
  } catch (err) {
    // If we have a stale cache, serve it rather than failing outright.
    if (cache) {
      return new Response(JSON.stringify(cache.data), {
        status: 200,
        headers: corsHeaders(),
      })
    }

    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Unknown error",
      }),
      { status: 502, headers: corsHeaders() }
    )
  }
}
