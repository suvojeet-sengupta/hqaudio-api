use crate::api::use_fetch;
use crate::crypto::{create_download_links, create_image_links, DownloadLink};
use crate::models::*;
use axum::{
    extract::{Path as AxumPath, Query},
    response::Html,
    Json,
};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use futures_util::{sink::SinkExt, stream::StreamExt};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

// --- Centralized Logs Authentication ---
// Password is loaded once from the environment and cached for the process lifetime.
// If LOGS_PASSWORD is not configured, all log access is denied (no insecure defaults).
static LOGS_PASSWORD_VALUE: Lazy<Option<String>> = Lazy::new(|| {
    std::env::var("LOGS_PASSWORD").ok().filter(|p| !p.is_empty())
});

/// Verify the provided password against the configured LOGS_PASSWORD.
/// Uses constant-time comparison to prevent timing-based side-channel attacks.
fn verify_logs_password(provided: &str) -> Result<(), AppError> {
    match LOGS_PASSWORD_VALUE.as_deref() {
        Some(correct) => {
            if constant_time_eq(provided.as_bytes(), correct.as_bytes()) {
                Ok(())
            } else {
                Err(AppError::Unauthorized("Incorrect password".to_string()))
            }
        }
        None => Err(AppError::Unauthorized(
            "Logs access is disabled: LOGS_PASSWORD is not configured".to_string(),
        )),
    }
}

/// Constant-time byte comparison to prevent timing attacks on password verification.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

// --- Helper Functions to Safely Extract Data from Raw Upstream JSON ---
fn str_val(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn opt_str_val(v: &Value) -> Option<String> {
    v.as_str().map(|s| s.to_string()).filter(|s| !s.is_empty())
}

fn bool_val(v: &Value) -> bool {
    v.as_str() == Some("1")
        || v.as_str() == Some("true")
        || v.as_bool() == Some(true)
        || v.as_i64() == Some(1)
}

fn i64_val(v: &Value) -> Option<i64> {
    if let Some(s) = v.as_str() {
        s.parse::<i64>().ok()
    } else {
        v.as_i64()
    }
}

fn i32_val(v: &Value) -> i32 {
    if let Some(s) = v.as_str() {
        s.parse::<i32>().unwrap_or(0)
    } else {
        v.as_i64().unwrap_or(0) as i32
    }
}

// --- Parsers for Nested Structs ---
fn parse_artist_map(v: &Value) -> Artist {
    Artist {
        id: str_val(&v["id"]),
        name: str_val(&v["name"]),
        role: str_val(&v["role"]),
        r#type: str_val(&v["type"]),
        image: create_image_links(&str_val(&v["image"])),
        url: str_val(&v["perma_url"]),
    }
}

fn parse_song(v: &Value) -> Song {
    let more_info = &v["more_info"];
    let artist_map = &more_info["artistMap"];

    let primary = artist_map["primary_artists"]
        .as_array()
        .map(|arr| arr.iter().map(parse_artist_map).collect())
        .unwrap_or_default();
    let featured = artist_map["featured_artists"]
        .as_array()
        .map(|arr| arr.iter().map(parse_artist_map).collect())
        .unwrap_or_default();
    let all = artist_map["artists"]
        .as_array()
        .map(|arr| arr.iter().map(parse_artist_map).collect())
        .unwrap_or_default();

    Song {
        id: str_val(&v["id"]),
        name: str_val(&v["title"]),
        r#type: str_val(&v["type"]),
        year: opt_str_val(&v["year"]),
        release_date: opt_str_val(&more_info["release_date"]),
        duration: i64_val(&more_info["duration"]),
        label: opt_str_val(&more_info["label"]),
        explicit_content: bool_val(&v["explicit_content"]),
        play_count: i64_val(&v["play_count"]),
        language: str_val(&v["language"]),
        has_lyrics: bool_val(&more_info["has_lyrics"]),
        lyrics_id: opt_str_val(&more_info["lyrics_id"]),
        url: str_val(&v["perma_url"]),
        copyright: opt_str_val(&more_info["copyright_text"]),
        album: AlbumInfo {
            id: opt_str_val(&more_info["album_id"]),
            name: opt_str_val(&more_info["album"]),
            url: opt_str_val(&more_info["album_url"]),
        },
        artists: ArtistGroup { primary, featured, all },
        image: create_image_links(&str_val(&v["image"])),
        download_url: create_download_links(&str_val(&more_info["encrypted_media_url"])),
    }
}

fn parse_artist(v: &Value) -> Artist {
    Artist {
        id: str_val(&v["id"]),
        name: str_val(&v["title"]),
        role: str_val(&v["role"]),
        r#type: str_val(&v["type"]),
        image: create_image_links(&str_val(&v["image"])),
        url: str_val(&v["perma_url"]),
    }
}

fn parse_album(v: &Value) -> Album {
    Album {
        id: str_val(&v["id"]),
        name: str_val(&v["title"]),
        year: opt_str_val(&v["year"]),
        url: str_val(&v["perma_url"]),
        image: create_image_links(&str_val(&v["image"])),
    }
}

fn parse_playlist(v: &Value) -> Playlist {
    Playlist {
        id: str_val(&v["id"]),
        name: if !str_val(&v["title"]).is_empty() {
            str_val(&v["title"])
        } else if !str_val(&v["listname"]).is_empty() {
            str_val(&v["listname"])
        } else {
            str_val(&v["name"])
        },
        url: if !str_val(&v["perma_url"]).is_empty() {
            str_val(&v["perma_url"])
        } else {
            str_val(&v["url"])
        },
        image: create_image_links(&str_val(&v["image"])),
        description: None,
        year: None,
        r#type: None,
        play_count: None,
        language: None,
        explicit_content: None,
        song_count: None,
        songs: None,
    }
}

// --- Handler Logic ---

#[derive(Deserialize, utoipa::IntoParams)]
pub struct SongsQuery {
    pub ids: Option<String>,
    pub link: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/songs",
    params(SongsQuery),
    responses(
        (status = 200, description = "Get songs by IDs or link", body = ApiResponseSongList)
    )
)]
pub async fn get_songs(
    Query(query): Query<SongsQuery>,
) -> Result<Json<ApiResponse<Vec<Song>>>, AppError> {
    if query.ids.is_none() && query.link.is_none() {
        return Err(AppError::BadRequest("Either 'ids' or 'link' query parameter is required".to_string()));
    }

    let mut params = HashMap::new();
    let endpoint = if let Some(link) = query.link {
        // extract link token
        let token = link
            .split("hqaudio.suvojeetsengupta.in/song/")
            .nth(1)
            .and_then(|s| s.split('/').nth(1))
            .and_then(|s| s.split('?').next())
            .ok_or_else(|| AppError::BadRequest("Invalid HqAudio song link".to_string()))?;
        params.insert("token".to_string(), token.to_string());
        params.insert("type".to_string(), "song".to_string());
        "webapi.get"
    } else {
        params.insert("pids".to_string(), query.ids.unwrap());
        "song.getDetails"
    };

    let raw = use_fetch(endpoint, params, None).await?;

    let songs_list = if endpoint == "webapi.get" {
        // webapi.get returns a wrapper or a song detail list inside a structured object
        raw["songs"]
            .as_array()
            .map(|arr| arr.iter().map(parse_song).collect::<Vec<Song>>())
            .unwrap_or_else(|| {
                // If it's a direct array response
                raw.as_array()
                    .map(|arr| arr.iter().map(parse_song).collect::<Vec<Song>>())
                    .unwrap_or_default()
            })
    } else {
        // song.getDetails returns {"songs": [...]} or just [...]
        raw["songs"]
            .as_array()
            .map(|arr| arr.iter().map(parse_song).collect::<Vec<Song>>())
            .unwrap_or_else(|| {
                raw.as_array()
                    .map(|arr| arr.iter().map(parse_song).collect::<Vec<Song>>())
                    .unwrap_or_default()
            })
    };

    if songs_list.is_empty() {
        return Err(AppError::NotFound("Song not found".to_string()));
    }

    Ok(Json(ApiResponse { success: true, data: songs_list }))
}

#[utoipa::path(
    get,
    path = "/api/songs/{id}",
    params(
        ("id" = String, Path, description = "Song ID")
    ),
    responses(
        (status = 200, description = "Get song details by ID", body = ApiResponseSongList)
    )
)]
pub async fn get_song_by_id(
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ApiResponse<Vec<Song>>>, AppError> {
    let mut params = HashMap::new();
    params.insert("pids".to_string(), id);

    let raw = use_fetch("song.getDetails", params, None).await?;
    let songs: Vec<Song> = raw["songs"]
        .as_array()
        .map(|arr| arr.iter().map(parse_song).collect())
        .unwrap_or_else(|| {
            raw.as_array()
                .map(|arr| arr.iter().map(parse_song).collect())
                .unwrap_or_default()
        });

    if songs.is_empty() {
        return Err(AppError::NotFound("Song not found".to_string()));
    }

    Ok(Json(ApiResponse { success: true, data: songs }))
}

#[derive(Deserialize, utoipa::IntoParams)]
pub struct SuggestionsQuery {
    pub limit: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/songs/{id}/suggestions",
    params(
        ("id" = String, Path, description = "Song ID"),
        SuggestionsQuery
    ),
    responses(
        (status = 200, description = "Get song suggestions", body = ApiResponseSongList)
    )
)]
pub async fn get_song_suggestions(
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SuggestionsQuery>,
) -> Result<Json<ApiResponse<Vec<Song>>>, AppError> {
    let limit = query.limit.unwrap_or_else(|| "10".to_string());
    
    // First, we need to create an entity station
    let mut station_params = HashMap::new();
    station_params.insert("entity_id".to_string(), id);
    station_params.insert("entity_type".to_string(), "queue".to_string());
    
    let station_raw = use_fetch("webradio.createEntityStation", station_params, None).await?;
    let station_id = match station_raw["stationid"].as_str() {
        Some(id) => id,
        None => return Ok(Json(ApiResponse { success: true, data: vec![] })),
    };

    // Now, get songs from the station
    let mut radio_params = HashMap::new();
    radio_params.insert("stationid".to_string(), station_id.to_string());
    radio_params.insert("k".to_string(), limit);

    let raw = use_fetch("webradio.getSong", radio_params, None).await?;
    
    // suggestions return list of items with details
    let mut songs = Vec::new();
    if let Some(arr) = raw.as_array() {
        for item in arr {
            if let Some(song_val) = item.get("song") {
                songs.push(parse_song(song_val));
            }
        }
    }

    Ok(Json(ApiResponse { success: true, data: songs }))
}

#[utoipa::path(
    get,
    path = "/api/songs/{id}/lyrics",
    params(
        ("id" = String, Path, description = "Song ID")
    ),
    responses(
        (status = 200, description = "Get song lyrics", body = ApiResponseLyrics)
    )
)]
pub async fn get_song_lyrics(
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ApiResponse<Lyrics>>, AppError> {
    let mut params = HashMap::new();
    params.insert("lyrics_id".to_string(), id);

    let raw = use_fetch("lyrics.getLyrics", params, None).await?;
    let lyrics = raw["lyrics"].as_str().ok_or_else(|| AppError::NotFound("Lyrics not found".to_string()))?;

    Ok(Json(ApiResponse {
        success: true,
        data: Lyrics {
            lyrics: lyrics.to_string(),
            copyright: opt_str_val(&raw["copyright"]),
            snippet: opt_str_val(&raw["snippet"]),
        },
    }))
}

#[derive(Deserialize, utoipa::IntoParams)]
pub struct SearchQuery {
    pub query: String,
}

fn parse_category<T>(cat: &Value, mapper: impl Fn(&Value) -> T) -> SearchResultCategory<T> {
    SearchResultCategory {
        results: cat["data"]
            .as_array()
            .map(|arr| arr.iter().map(|item| mapper(item)).collect())
            .unwrap_or_default(),
        position: i32_val(&cat["position"]),
    }
}

#[utoipa::path(
    get,
    path = "/api/search",
    params(SearchQuery),
    responses(
        (status = 200, description = "Global search", body = ApiResponseSearchResponse)
    )
)]
pub async fn search_all(
    Query(query): Query<SearchQuery>,
) -> Result<Json<ApiResponse<SearchResponse>>, AppError> {
    let mut params = HashMap::new();
    params.insert("query".to_string(), query.query);

    let raw = use_fetch("autocomplete.get", params, None).await?;

    let map_song = |v: &Value| SongSearchItem {
        id: str_val(&v["id"]),
        title: str_val(&v["title"]),
        image: create_image_links(&str_val(&v["image"])),
        album: str_val(&v["album"]),
        url: str_val(&v["url"]),
        r#type: str_val(&v["type"]),
        description: str_val(&v["description"]),
        primary_artists: str_val(&v["more_info"]["primary_artists"]),
        singers: str_val(&v["more_info"]["singers"]),
        language: str_val(&v["more_info"]["language"]),
    };

    let map_album = |v: &Value| AlbumSearchItem {
        id: str_val(&v["id"]),
        title: str_val(&v["title"]),
        image: create_image_links(&str_val(&v["image"])),
        artist: str_val(&v["music"]),
        url: str_val(&v["url"]),
        r#type: str_val(&v["type"]),
        description: str_val(&v["description"]),
        year: str_val(&v["more_info"]["year"]),
        language: str_val(&v["more_info"]["language"]),
        song_ids: str_val(&v["more_info"]["song_pids"]),
    };

    let map_artist = |v: &Value| ArtistSearchItem {
        id: str_val(&v["id"]),
        title: str_val(&v["title"]),
        image: create_image_links(&str_val(&v["image"])),
        r#type: str_val(&v["type"]),
        description: str_val(&v["description"]),
        position: i32_val(&v["position"]),
    };

    let map_playlist = |v: &Value| PlaylistSearchItem {
        id: str_val(&v["id"]),
        title: str_val(&v["title"]),
        image: create_image_links(&str_val(&v["image"])),
        url: str_val(&v["url"]),
        language: str_val(&v["more_info"]["language"]),
        r#type: str_val(&v["type"]),
        description: str_val(&v["description"]),
    };

    Ok(Json(ApiResponse {
        success: true,
        data: SearchResponse {
            albums: parse_category(&raw["albums"], map_album),
            songs: parse_category(&raw["songs"], map_song),
            artists: parse_category(&raw["artists"], map_artist),
            playlists: parse_category(&raw["playlists"], map_playlist),
            top_query: parse_category(&raw["topquery"], map_song),
        },
    }))
}

#[derive(Deserialize, utoipa::IntoParams)]
pub struct CategorySearchQuery {
    pub query: String,
    pub page: Option<i32>,
    pub limit: Option<i32>,
}

#[utoipa::path(
    get,
    path = "/api/search/songs",
    params(CategorySearchQuery),
    responses(
        (status = 200, description = "Search songs", body = ApiResponseSongCategory)
    )
)]
pub async fn search_songs(
    Query(query): Query<CategorySearchQuery>,
) -> Result<Json<ApiResponse<SearchResultCategory<Song>>>, AppError> {
    let mut params = HashMap::new();
    params.insert("p".to_string(), query.page.unwrap_or(1).to_string());
    params.insert("n".to_string(), query.limit.unwrap_or(20).to_string());
    params.insert("q".to_string(), query.query);

    let raw = use_fetch("search.getResults", params, None).await?;
    let results = raw["results"]
        .as_array()
        .map(|arr| arr.iter().map(parse_song).collect())
        .unwrap_or_default();

    Ok(Json(ApiResponse {
        success: true,
        data: SearchResultCategory { results, position: 1 },
    }))
}

#[utoipa::path(
    get,
    path = "/api/search/artists",
    params(CategorySearchQuery),
    responses(
        (status = 200, description = "Search artists", body = ApiResponseArtistCategory)
    )
)]
pub async fn search_artists(
    Query(query): Query<CategorySearchQuery>,
) -> Result<Json<ApiResponse<SearchResultCategory<Artist>>>, AppError> {
    let mut params = HashMap::new();
    params.insert("p".to_string(), query.page.unwrap_or(1).to_string());
    params.insert("n".to_string(), query.limit.unwrap_or(20).to_string());
    params.insert("q".to_string(), query.query);

    let raw = use_fetch("search.getArtistResults", params, None).await?;
    let results = raw["results"]
        .as_array()
        .map(|arr| arr.iter().map(parse_artist).collect())
        .unwrap_or_default();

    Ok(Json(ApiResponse {
        success: true,
        data: SearchResultCategory { results, position: 1 },
    }))
}

#[derive(Deserialize, utoipa::IntoParams)]
pub struct IdQuery {
    pub id: String,
}

#[utoipa::path(
    get,
    path = "/api/albums",
    params(IdQuery),
    responses(
        (status = 200, description = "Get album details", body = ApiResponseSongList)
    )
)]
pub async fn get_album_details(
    Query(query): Query<IdQuery>,
) -> Result<Json<ApiResponse<Vec<Song>>>, AppError> {
    let mut params = HashMap::new();
    params.insert("albumid".to_string(), query.id);

    let raw = use_fetch("content.getAlbumDetails", params, None).await?;
    let songs = raw["songs"]
        .as_array()
        .map(|arr| arr.iter().map(parse_song).collect())
        .unwrap_or_default();

    Ok(Json(ApiResponse { success: true, data: songs }))
}

#[utoipa::path(
    get,
    path = "/api/playlists",
    params(IdQuery),
    responses(
        (status = 200, description = "Get playlist details", body = ApiResponsePlaylistDetail)
    )
)]
pub async fn get_playlist_details(
    Query(query): Query<IdQuery>,
) -> Result<Json<ApiResponse<Playlist>>, AppError> {
    let mut params = HashMap::new();
    params.insert("listid".to_string(), query.id);

    let raw = use_fetch("playlist.getDetails", params, None).await?;
    let songs = raw["list"]
        .as_array()
        .map(|arr| arr.iter().map(parse_song).collect::<Vec<Song>>())
        .unwrap_or_default();
        
    let song_count = songs.len() as i32;

    let playlist = Playlist {
        id: str_val(&raw["id"]),
        name: if !str_val(&raw["title"]).is_empty() {
            str_val(&raw["title"])
        } else if !str_val(&raw["listname"]).is_empty() {
            str_val(&raw["listname"])
        } else {
            str_val(&raw["name"])
        },
        description: raw["header_desc"].as_str().map(|s| s.to_string()),
        year: str_val(&raw["year"]).parse().ok(),
        r#type: raw["type"].as_str().map(|s| s.to_string()),
        play_count: str_val(&raw["play_count"]).parse().ok(),
        language: raw["language"].as_str().map(|s| s.to_string()),
        explicit_content: Some(raw["explicit_content"].as_str() == Some("1")),
        song_count: Some(song_count),
        url: if !str_val(&raw["perma_url"]).is_empty() {
            str_val(&raw["perma_url"])
        } else {
            str_val(&raw["url"])
        },
        image: create_image_links(&str_val(&raw["image"])),
        songs: Some(songs),
    };

    Ok(Json(ApiResponse {
        success: true,
        data: playlist,
    }))
}

#[derive(Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct ArtistQuery {
    pub page: Option<i32>,
    pub song_count: Option<i32>,
    pub album_count: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtistDetail {
    pub id: String,
    pub name: String,
    pub fan_count: Option<String>,
    pub wiki: Option<String>,
    pub image: Vec<DownloadLink>,
    pub top_songs: Vec<Song>,
    pub top_albums: Vec<Album>,
}

#[utoipa::path(
    get,
    path = "/api/artists/{id}",
    params(
        ("id" = String, Path, description = "Artist ID"),
        ArtistQuery
    ),
    responses(
        (status = 200, description = "Get artist details", body = ApiResponseArtistDetail)
    )
)]
pub async fn get_artist_details(
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ArtistQuery>,
) -> Result<Json<ApiResponse<ArtistDetail>>, AppError> {
    let mut params = HashMap::new();
    params.insert("artistId".to_string(), id);
    params.insert("page".to_string(), query.page.unwrap_or(1).to_string());
    params.insert("song_count".to_string(), query.song_count.unwrap_or(20).to_string());
    params.insert("album_count".to_string(), query.album_count.unwrap_or(20).to_string());

    let raw = use_fetch("artist.getArtistPageDetails", params, None).await?;

    let top_songs = raw["topSongs"]
        .as_array()
        .map(|arr| arr.iter().map(parse_song).collect())
        .unwrap_or_default();

    let top_albums = raw["topAlbums"]
        .as_array()
        .map(|arr| arr.iter().map(parse_album).collect())
        .unwrap_or_default();

    let name = str_val(&raw["name"]);
    if name.is_empty() {
        return Err(AppError::NotFound("Artist not found or invalid ID".to_string()));
    }

    Ok(Json(ApiResponse {
        success: true,
        data: ArtistDetail {
            id: str_val(&raw["artistId"]),
            name,
            fan_count: opt_str_val(&raw["fan_count"]),
            wiki: opt_str_val(&raw["wiki"]),
            image: create_image_links(&str_val(&raw["image"])),
            top_songs,
            top_albums,
        },
    }))
}

#[utoipa::path(
    get,
    path = "/api/search/albums",
    params(CategorySearchQuery),
    responses(
        (status = 200, description = "Search albums", body = ApiResponseAlbumCategory)
    )
)]
pub async fn search_albums(
    Query(query): Query<CategorySearchQuery>,
) -> Result<Json<ApiResponse<SearchResultCategory<Album>>>, AppError> {
    let mut params = HashMap::new();
    params.insert("p".to_string(), query.page.unwrap_or(1).to_string());
    params.insert("n".to_string(), query.limit.unwrap_or(20).to_string());
    params.insert("q".to_string(), query.query);

    let raw = use_fetch("search.getAlbumResults", params, None).await?;
    let results = raw["results"]
        .as_array()
        .map(|arr| arr.iter().map(parse_album).collect())
        .unwrap_or_default();

    Ok(Json(ApiResponse {
        success: true,
        data: SearchResultCategory { results, position: 1 },
    }))
}

#[utoipa::path(
    get,
    path = "/api/search/playlists",
    params(CategorySearchQuery),
    responses(
        (status = 200, description = "Search playlists", body = ApiResponsePlaylistCategory)
    )
)]
pub async fn search_playlists(
    Query(query): Query<CategorySearchQuery>,
) -> Result<Json<ApiResponse<SearchResultCategory<Playlist>>>, AppError> {
    let mut params = HashMap::new();
    params.insert("p".to_string(), query.page.unwrap_or(1).to_string());
    params.insert("n".to_string(), query.limit.unwrap_or(20).to_string());
    params.insert("q".to_string(), query.query);

    let raw = use_fetch("search.getPlaylistResults", params, None).await?;
    let results = raw["results"]
        .as_array()
        .map(|arr| arr.iter().map(parse_playlist).collect())
        .unwrap_or_default();

    Ok(Json(ApiResponse {
        success: true,
        data: SearchResultCategory { results, position: 1 },
    }))
}

// --- Logs UI and API Handlers ---

pub async fn logs_ui() -> Html<&'static str> {
    Html(include_str!("logs_ui/index.html"))
}

pub async fn logs_css() -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "text/css")],
        include_str!("logs_ui/styles.css"),
    )
}

pub async fn logs_js() -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/javascript")],
        include_str!("logs_ui/script.js"),
    )
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct LogsAuthPayload {
    pub password: String,
}

pub async fn get_log_files(
    Json(payload): Json<LogsAuthPayload>,
) -> Result<Json<ApiResponse<Vec<String>>>, AppError> {
    verify_logs_password(&payload.password)?;

    // 2. Read logs directory (async to avoid blocking the Tokio runtime)
    let log_dir = "logs";
    let mut files = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(log_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if let Ok(meta) = tokio::fs::metadata(&path).await {
                if meta.is_file() {
                    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                        if file_name.starts_with("requests_") && file_name.ends_with(".log") {
                            files.push(file_name.to_string());
                        }
                    }
                }
            }
        }
    }

    // Sort files in reverse order (newest first)
    files.sort_by(|a, b| b.cmp(a));

    Ok(Json(ApiResponse {
        success: true,
        data: files,
    }))
}

async fn read_log_tail(path: &str, max_lines: usize, max_bytes: u64) -> Result<String, std::io::Error> {
    use tokio::fs::File;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
    
    let mut file = File::open(path).await?;
    let metadata = file.metadata().await?;
    let file_len = metadata.len();
    
    if file_len <= max_bytes {
        let mut content = String::new();
        file.read_to_string(&mut content).await?;
        let lines: Vec<&str> = content.lines().collect();
        if lines.len() > max_lines {
            return Ok(lines[lines.len() - max_lines..].join("\n"));
        }
        return Ok(content);
    }
    
    let seek_pos = file_len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(seek_pos)).await?;
    
    let mut buffer = Vec::with_capacity(max_bytes as usize);
    file.read_to_end(&mut buffer).await?;
    
    let text = String::from_utf8_lossy(&buffer);
    let mut lines: Vec<&str> = text.lines().collect();
    if seek_pos > 0 && !lines.is_empty() {
        lines.remove(0); // Discard potential partial line
    }
    if lines.len() > max_lines {
        lines = lines[lines.len() - max_lines..].to_vec();
    }
    Ok(lines.join("\n"))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct ViewLogPayload {
    pub password: String,
    pub file_name: String,
}

pub async fn view_log_file(
    Json(payload): Json<ViewLogPayload>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    verify_logs_password(&payload.password)?;

    // 2. Prevent directory traversal (sanitize file_name)
    let file_name = payload.file_name;
    if !file_name.starts_with("requests_") || !file_name.ends_with(".log") || file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err(AppError::BadRequest("Invalid log file name".to_string()));
    }

    // 3. Read file tail safely (async & bounded memory)
    let path = format!("logs/{}", file_name);
    match read_log_tail(&path, 10000, 10 * 1024 * 1024).await {
        Ok(content) => Ok(Json(ApiResponse {
            success: true,
            data: content,
        })),
        Err(e) => Err(AppError::NotFound(format!("Log file not found or unreadable: {}", e))),
    }
}

pub async fn clear_log_file(
    Json(payload): Json<ViewLogPayload>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    verify_logs_password(&payload.password)?;

    // 2. Prevent directory traversal (sanitize file_name)
    let file_name = payload.file_name;
    if !file_name.starts_with("requests_") || !file_name.ends_with(".log") || file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err(AppError::BadRequest("Invalid log file name".to_string()));
    }

    // 3. Truncate (clear) the file (async to avoid blocking the Tokio runtime)
    let path = format!("logs/{}", file_name);
    match tokio::fs::write(&path, "").await {
        Ok(_) => Ok(Json(ApiResponse {
            success: true,
            data: format!("Log file {} cleared successfully", file_name),
        })),
        Err(e) => Err(AppError::Internal(format!("Failed to clear log file: {}", e))),
    }
}

#[derive(Deserialize)]
pub struct WsParams {
    pub password: Option<String>,
    #[serde(rename = "file_name")]
    pub file_name: Option<String>,
}

pub async fn logs_ws(
    ws: WebSocketUpgrade,
    Query(params): Query<WsParams>,
) -> impl axum::response::IntoResponse {
    let auth_result = match params.password {
        Some(ref pwd) => verify_logs_password(pwd),
        None => Err(AppError::Unauthorized("Password required".to_string())),
    };

    if auth_result.is_err() {
        return axum::response::Response::builder()
            .status(axum::http::StatusCode::UNAUTHORIZED)
            .body(axum::body::Body::empty())
            .unwrap();
    }

    let file_name = params.file_name.unwrap_or_default();

    ws.on_upgrade(move |socket| handle_ws(socket, file_name))
}

async fn handle_ws(socket: WebSocket, file_name: String) {
    let (mut sender, mut receiver) = socket.split();

    // 1. Prevent directory traversal (sanitize file_name)
    if !file_name.is_empty() {
        if !file_name.starts_with("requests_") || !file_name.ends_with(".log") || file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
            let _ = sender.send(Message::Text("Error: Invalid log file name".to_string())).await;
            return;
        }
    }

    // Determine target file to read
    let target_file = if file_name.is_empty() {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        format!("requests_{}.log", today)
    } else {
        file_name.clone()
    };

    // 2. Load latest history tail (bounded async read to avoid memory overload)
    let path = format!("logs/{}", target_file);
    if let Ok(content) = read_log_tail(&path, 10000, 10 * 1024 * 1024).await {
        // Send initial dump of logs
        let _ = sender.send(Message::Text(format!("[INITIAL_DUMP]\n{}", content))).await;
    } else {
        let _ = sender.send(Message::Text("[INITIAL_DUMP]\n".to_string())).await;
    }

    // 3. If it's today's log file, stream live updates!
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let today_file = format!("requests_{}.log", today);

    if target_file == today_file {
        // Subscribe to global log broadcast channel
        let mut rx = crate::LOG_BROADCAST.subscribe();

        // Ping/pong keepalive: send ping every 30s to detect dead connections
        let mut ping_interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Skip the first immediate tick
        ping_interval.tick().await;

        // Spawn a task to listen to client messages (disconnect + pong detection)
        let (pong_tx, mut pong_rx) = tokio::sync::mpsc::channel::<()>(1);
        let mut read_task = tokio::spawn(async move {
            while let Some(Ok(msg)) = receiver.next().await {
                match msg {
                    Message::Close(_) => break,
                    Message::Pong(_) => { let _ = pong_tx.try_send(()); },
                    _ => {}
                }
            }
        });

        // Loop and stream new log lines + keepalive pings
        loop {
            tokio::select! {
                _ = &mut read_task => {
                    break;
                }
                val = rx.recv() => {
                    match val {
                        Ok(log_line) => {
                            if sender.send(Message::Text(log_line)).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            // Notify client about dropped messages
                            let _ = sender.send(Message::Text(
                                format!("[SYSTEM] Warning: {} log messages were dropped due to slow connection", n)
                            )).await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
                _ = ping_interval.tick() => {
                    // Send WebSocket ping for keepalive
                    if sender.send(Message::Ping(vec![b'k', b'a'])).await.is_err() {
                        break;
                    }
                    // Wait up to 10s for a pong response
                    let pong_timeout = tokio::time::timeout(
                        tokio::time::Duration::from_secs(10),
                        pong_rx.recv()
                    ).await;
                    if pong_timeout.is_err() {
                        // No pong received — connection is dead
                        break;
                    }
                }
            }
        }
        read_task.abort();
    }
}

#[derive(Deserialize)]
pub struct UnbanPayload {
    pub password: String,
    pub ip: String,
}

pub async fn get_banned_ips(
    Json(payload): Json<LogsAuthPayload>,
) -> Result<Json<ApiResponse<Vec<String>>>, AppError> {
    verify_logs_password(&payload.password)?;
    
    let mut banned_ips_set = std::collections::HashSet::new();

    for ip in crate::MEMORY_BAN_MANAGER.get_banned_ips() {
        banned_ips_set.insert(ip);
    }

    if let Some(pool) = crate::api::REDIS_POOL.get() {
        if let Ok(mut conn) = pool.get().await {
            let mut keys_cmd = redis::cmd("KEYS");
            keys_cmd.arg("ban:*");
            if let Ok(keys) = keys_cmd.query_async::<Vec<String>>(&mut *conn).await {
                for key in keys {
                    if let Some(ip) = key.strip_prefix("ban:") {
                        banned_ips_set.insert(ip.to_string());
                    }
                }
            }
        }
    }
    
    let banned_ips: Vec<String> = banned_ips_set.into_iter().collect();

    Ok(Json(ApiResponse {
        success: true,
        data: banned_ips,
    }))
}

pub async fn unban_ip(
    Json(payload): Json<UnbanPayload>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    verify_logs_password(&payload.password)?;
    
    crate::MEMORY_BAN_MANAGER.unban_ip(&payload.ip);

    if let Some(pool) = crate::api::REDIS_POOL.get() {
        if let Ok(mut conn) = pool.get().await {
            use redis::AsyncCommands;
            let ban_key = format!("ban:{}", payload.ip);
            let _: Result<(), _> = conn.del(&ban_key).await;
            
            let strike_key = format!("strikes:{}", payload.ip);
            let _: Result<(), _> = conn.del(&strike_key).await;
        }
    }
    
    let _ = crate::LOG_CHANNEL.send(format!("[SYSTEM] IP {} was manually unbanned by admin", payload.ip));

    Ok(Json(ApiResponse {
        success: true,
        data: serde_json::Value::Null,
    }))
}

