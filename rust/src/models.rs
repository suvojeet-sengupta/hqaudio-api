use crate::crypto::DownloadLink;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub year: Option<String>,
    pub release_date: Option<String>,
    pub duration: Option<i64>,
    pub label: Option<String>,
    pub explicit_content: bool,
    pub play_count: Option<i64>,
    pub language: String,
    pub has_lyrics: bool,
    pub lyrics_id: Option<String>,
    pub url: String,
    pub copyright: Option<String>,
    pub album: AlbumInfo,
    pub artists: ArtistGroup,
    pub image: Vec<DownloadLink>,
    pub download_url: Vec<DownloadLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlbumInfo {
    pub id: Option<String>,
    pub name: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtistGroup {
    pub primary: Vec<Artist>,
    pub featured: Vec<Artist>,
    pub all: Vec<Artist>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: String,
    pub name: String,
    pub role: String,
    pub r#type: String,
    pub image: Vec<DownloadLink>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub name: String,
    pub year: Option<String>,
    pub url: String,
    pub image: Vec<DownloadLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub lyrics: String,
    pub copyright: Option<String>,
    pub snippet: Option<String>,
}

// Search result categories
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[aliases(
    SongSearchCategory = SearchResultCategory<SongSearchItem>,
    AlbumSearchCategory = SearchResultCategory<AlbumSearchItem>,
    ArtistSearchCategory = SearchResultCategory<ArtistSearchItem>,
    PlaylistSearchCategory = SearchResultCategory<PlaylistSearchItem>,
    SongCategory = SearchResultCategory<Song>,
    ArtistCategory = SearchResultCategory<Artist>,
    PlaylistCategory = SearchResultCategory<Playlist>,
    AlbumCategory = SearchResultCategory<Album>
)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultCategory<T> {
    pub results: Vec<T>,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SongSearchItem {
    pub id: String,
    pub title: String,
    pub image: Vec<DownloadLink>,
    pub album: String,
    pub url: String,
    pub r#type: String,
    pub description: String,
    pub primary_artists: String,
    pub singers: String,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSearchItem {
    pub id: String,
    pub title: String,
    pub image: Vec<DownloadLink>,
    pub artist: String,
    pub url: String,
    pub r#type: String,
    pub description: String,
    pub year: String,
    pub language: String,
    pub song_ids: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSearchItem {
    pub id: String,
    pub title: String,
    pub image: Vec<DownloadLink>,
    pub r#type: String,
    pub description: String,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSearchItem {
    pub id: String,
    pub title: String,
    pub image: Vec<DownloadLink>,
    pub url: String,
    pub language: String,
    pub r#type: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub year: Option<i32>,
    pub r#type: Option<String>,
    pub play_count: Option<i32>,
    pub language: Option<String>,
    pub explicit_content: Option<bool>,
    pub song_count: Option<i32>,
    pub url: String,
    pub image: Vec<DownloadLink>,
    pub songs: Option<Vec<Song>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub albums: SearchResultCategory<AlbumSearchItem>,
    pub songs: SearchResultCategory<SongSearchItem>,
    pub artists: SearchResultCategory<ArtistSearchItem>,
    pub playlists: SearchResultCategory<PlaylistSearchItem>,
    pub top_query: SearchResultCategory<SongSearchItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[aliases(
    ApiResponseSongList = ApiResponse<Vec<Song>>,
    ApiResponseSongCategory = ApiResponse<SearchResultCategory<Song>>,
    ApiResponseArtistCategory = ApiResponse<SearchResultCategory<Artist>>,
    ApiResponsePlaylistCategory = ApiResponse<SearchResultCategory<Playlist>>,
    ApiResponseAlbumCategory = ApiResponse<SearchResultCategory<Album>>,
    ApiResponseArtistDetail = ApiResponse<crate::handlers::ArtistDetail>,
    ApiResponsePlaylistDetail = ApiResponse<Playlist>,
    ApiResponseSearchResponse = ApiResponse<SearchResponse>,
    ApiResponseLyrics = ApiResponse<Lyrics>,
    ApiResponseStringList = ApiResponse<Vec<String>>,
    ApiResponseString = ApiResponse<String>
)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: T,
}

#[derive(Debug, Clone)]
pub enum AppError {
    BadRequest(String),
    Unauthorized(String),
    NotFound(String),
    Internal(String),
}

#[derive(Serialize, utoipa::ToSchema)]
struct ErrorResponse {
    success: bool,
    message: String,
}

impl axum::response::IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            AppError::BadRequest(msg) => (axum::http::StatusCode::BAD_REQUEST, msg),
            AppError::Unauthorized(msg) => (axum::http::StatusCode::UNAUTHORIZED, msg),
            AppError::NotFound(msg) => (axum::http::StatusCode::NOT_FOUND, msg),
            AppError::Internal(msg) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, msg),
        };

        let body = axum::Json(ErrorResponse {
            success: false,
            message,
        });

        (status, body).into_response()
    }
}

impl From<String> for AppError {
    fn from(err: String) -> Self {
        AppError::Internal(err)
    }
}

