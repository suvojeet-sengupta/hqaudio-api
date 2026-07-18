mod api;
mod crypto;
mod handlers;
mod models;

use axum::{
    extract::Request,
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use chrono::{Duration, Local};
use once_cell::sync::Lazy;
use std::net::SocketAddr;
use std::time::Instant;
use tokio::fs::{create_dir_all, OpenOptions};
use tokio::io::AsyncWriteExt;
use tower_http::cors::CorsLayer;
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;
use bb8_redis::RedisConnectionManager;
use tower_governor::{governor::GovernorConfigBuilder, GovernorLayer};
use tower_governor::key_extractor::SmartIpKeyExtractor;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

#[derive(OpenApi)]
#[openapi(
    paths(
        handlers::get_songs,
        handlers::get_song_by_id,
        handlers::get_song_suggestions,
        handlers::get_song_lyrics,
        handlers::search_all,
        handlers::search_songs,
        handlers::search_artists,
        handlers::get_album_details,
        handlers::get_playlist_details,
        handlers::get_artist_details,
        handlers::search_albums,
        handlers::search_playlists
    ),
    components(
        schemas(
            models::Song,
            models::AlbumInfo,
            models::ArtistGroup,
            models::Artist,
            models::Album,
            models::Lyrics,
            models::SongSearchItem,
            models::AlbumSearchItem,
            models::ArtistSearchItem,
            models::PlaylistSearchItem,
            models::Playlist,
            models::SearchResponse,
            crypto::DownloadLink,
            handlers::ArtistDetail,
            models::SongSearchCategory,
            models::AlbumSearchCategory,
            models::ArtistSearchCategory,
            models::PlaylistSearchCategory,
            models::SongCategory,
            models::ArtistCategory,
            models::PlaylistCategory,
            models::AlbumCategory,
            models::ApiResponseSongList,
            models::ApiResponseSongCategory,
            models::ApiResponseArtistCategory,
            models::ApiResponsePlaylistCategory,
            models::ApiResponsePlaylistDetail,
            models::ApiResponseAlbumCategory,
            models::ApiResponseArtistDetail,
            models::ApiResponseSearchResponse,
            models::ApiResponseLyrics,
            models::ApiResponseStringList,
            models::ApiResponseString
        )
    ),
    tags(
        (name = "hqaudio-api", description = "HqAudio API endpoints")
    )
)]
struct ApiDoc;

#[tokio::main]
async fn main() {
    // Load environment variables from .env file
    let _ = dotenvy::dotenv();

    // 1. Initialize tracer logging
    tracing_subscriber::fmt::init();

    // 1.5 Initialize Redis Pool
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/0".to_string());
    if let Ok(manager) = RedisConnectionManager::new(redis_url) {
        if let Ok(pool) = bb8_redis::bb8::Pool::builder()
                .max_size(20)
                .min_idle(Some(5))
                .connection_timeout(std::time::Duration::from_secs(3))
                .build(manager).await {
            let _ = api::REDIS_POOL.set(pool);
            println!("✅ Connected to Redis successfully");
        } else {
            eprintln!("⚠️ Failed to create Redis pool");
        }
    } else {
        eprintln!("⚠️ Invalid REDIS_URL");
    }

    // Start background log rotation cleanup
    tokio::spawn(clean_old_logs_task());
    tokio::spawn(system_status_task());

    // 2. Setup CORS
    let cors = CorsLayer::permissive();

    // 2.5 Setup Rate Limiter (10 req/sec per IP, burst up to 50)
    let governor_conf = std::sync::Arc::new(
        GovernorConfigBuilder::default()
            .per_second(10)
            .burst_size(50)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    // 3. Define routes
    let app = Router::new()
        // API Base Info
        .route("/", get(home_handler))
        // Swagger UI
        .merge(SwaggerUi::new("/docs").url("/api-docs/openapi.json", ApiDoc::openapi()))
        // API Endpoints
        .route("/api/search", get(handlers::search_all))
        .route("/api/search/songs", get(handlers::search_songs))
        .route("/api/search/artists", get(handlers::search_artists))
        .route("/api/search/albums", get(handlers::search_albums))
        .route("/api/search/playlists", get(handlers::search_playlists))
        .route("/api/songs", get(handlers::get_songs))
        .route("/api/songs/:id", get(handlers::get_song_by_id))
        .route("/api/songs/:id/suggestions", get(handlers::get_song_suggestions))
        .route("/api/songs/:id/lyrics", get(handlers::get_song_lyrics))
        .route("/api/albums", get(handlers::get_album_details))
        .route("/api/playlists", get(handlers::get_playlist_details))
        .route("/api/artists/:id", get(handlers::get_artist_details))
        // Logs UI & Viewer
        .route("/logs", get(handlers::logs_ui))
        .route("/api/logs/styles.css", get(handlers::logs_css))
        .route("/api/logs/script.js", get(handlers::logs_js))
        .route("/api/logs/files", post(handlers::get_log_files))
        .route("/api/logs/view", post(handlers::view_log_file))
        .route("/api/logs/ws", get(handlers::logs_ws))
        .route("/api/logs/clear", post(handlers::clear_log_file))
        .route("/api/logs/bans", post(handlers::get_banned_ips))
        .route("/api/logs/unban", post(handlers::unban_ip))
        // Middlewares
        .layer(cors)
        .layer(CompressionLayer::new().gzip(true).br(true))
        .layer(TraceLayer::new_for_http())
        .layer(GovernorLayer { config: governor_conf })
        .layer(middleware::from_fn(logging_middleware))
        .fallback(not_found_handler);

    // 4. Bind and start Axum server
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("Started Rust server: http://{}", addr);
    
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    println!("✅ Shutdown signal received, starting graceful shutdown...");
}

async fn home_handler() -> impl IntoResponse {
    (
        StatusCode::OK,
        [("Content-Type", "application/json")],
        r#"{"success":true,"message":"Welcome to HqAudio API in Rust! Check out docs at https://hqaudio.suvojeetsengupta.in/docs"}"#,
    )
}

async fn not_found_handler() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        [("Content-Type", "application/json")],
        r#"{"success":false,"message":"Route not found, check docs at https://hqaudio.suvojeetsengupta.in/docs"}"#,
    )
}

pub static LOG_BROADCAST: Lazy<tokio::sync::broadcast::Sender<String>> = Lazy::new(|| {
    let (tx, _) = tokio::sync::broadcast::channel(1024);
    tx
});

pub static LOG_CHANNEL: Lazy<tokio::sync::mpsc::UnboundedSender<String>> = Lazy::new(|| {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    
    tokio::spawn(async move {
        let log_dir = "logs";
        if let Err(e) = create_dir_all(log_dir).await {
            eprintln!("Failed to create logs directory: {}", e);
            return;
        }

        let mut current_date = String::new();
        let mut current_file: Option<tokio::io::BufWriter<tokio::fs::File>> = None;
        let mut needs_flush = false;

        // Interval-based flush: flush at most every 500ms instead of every write
        let mut flush_interval = tokio::time::interval(tokio::time::Duration::from_millis(500));
        flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(raw_msg) => {
                            let now = Local::now();
                            let timestamp = now.format("%Y-%m-%d %H:%M:%S").to_string();
                            let date_str = now.format("%Y-%m-%d").to_string();
                            
                            let log_line = format!("[{}] {}", timestamp, raw_msg);
                            
                            // Print to stdout
                            println!("{}", log_line);

                            // If date changed, rotate file
                            if date_str != current_date || current_file.is_none() {
                                current_date = date_str.clone();
                                let log_path = format!("{}/requests_{}.log", log_dir, current_date);
                                
                                // Flush and close previous file if it exists
                                if let Some(mut file) = current_file.take() {
                                    let _ = file.flush().await;
                                    needs_flush = false;
                                }

                                match OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(&log_path)
                                    .await
                                {
                                    Ok(file) => {
                                        current_file = Some(tokio::io::BufWriter::new(file));
                                    }
                                    Err(e) => {
                                        eprintln!("Failed to open log file {}: {}", log_path, e);
                                    }
                                }
                            }

                            if let Some(ref mut file) = current_file {
                                let file_log_line = format!("{}\n", log_line);
                                if let Err(e) = file.write_all(file_log_line.as_bytes()).await {
                                    eprintln!("Failed to write request log: {}", e);
                                } else {
                                    needs_flush = true;
                                }
                            }

                            // Broadcast to all active WebSocket connections
                            let _ = LOG_BROADCAST.send(log_line);
                        }
                        None => {
                            // Channel closed, flush and exit
                            if let Some(mut file) = current_file.take() {
                                let _ = file.flush().await;
                            }
                            break;
                        }
                    }
                }
                _ = flush_interval.tick() => {
                    // Periodic flush to disk
                    if needs_flush {
                        if let Some(ref mut file) = current_file {
                            let _ = file.flush().await;
                        }
                        needs_flush = false;
                    }
                }
            }
        }
    });
    
    tx
});

async fn logging_middleware(req: Request, next: Next) -> Response {
    let start = Instant::now();
    let method = req.method().to_string();
    let uri = req.uri().to_string();
    
    let user_agent = req
        .headers()
        .get(axum::http::header::USER_AGENT)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    // Smart Logging: Extract Real IP Address (Support for Proxies & Docker NAT)
    let ip = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.split(',').next().unwrap_or("").trim().to_string())
        .or_else(|| {
            req.headers()
                .get("x-real-ip")
                .and_then(|h| h.to_str().ok())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| {
            req.extensions()
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|ci| ci.0.ip().to_string())
                .unwrap_or_else(|| "unknown".to_string())
        });
        
    // --- DDOS BLOCKLIST CHECK ---
    if let Some(pool) = crate::api::REDIS_POOL.get() {
        if let Ok(mut conn) = pool.get().await {
            use redis::AsyncCommands;
            let ban_key = format!("ban:{}", ip);
            let is_banned: bool = conn.exists(&ban_key).await.unwrap_or(false);
            if is_banned {
                let _ = crate::LOG_CHANNEL.send(format!("[DDOS PROTECT] Blocked request from banned IP: {}", ip));
                return (axum::http::StatusCode::FORBIDDEN, "IP blocked for 24 hours due to abuse").into_response();
            }
        }
    }
    // ----------------------------
    
    let response = next.run(req).await;
    let status = response.status().as_u16();
    
    // --- DDOS STRIKE TRACKING ---
    if status == 429 { // Too Many Requests
        if let Some(pool) = crate::api::REDIS_POOL.get() {
            if let Ok(mut conn) = pool.get().await {
                use redis::AsyncCommands;
                let strike_key = format!("strikes:{}", ip);
                let strikes: i32 = conn.incr(&strike_key, 1).await.unwrap_or(0);
                if strikes == 1 {
                    let _: Result<(), _> = conn.expire(&strike_key, 60).await; // 1 min window
                }
                
                if strikes >= 100 { // 100 rate limit hits in 1 minute
                    let ban_key = format!("ban:{}", ip);
                    let _: Result<(), _> = conn.set_ex(&ban_key, "1", 86400).await; // Ban for 24h
                    let _ = crate::LOG_CHANNEL.send(format!("[DDOS PROTECT] 🚨 BANNED IP {} for 24 hours after {} strikes", ip, strikes));
                }
            }
        }
    }
    // ----------------------------
    
    // Smart Logging: Ignore /logs and /api/logs requests to avoid spamming our own logs
    if uri.starts_with("/logs") || uri.starts_with("/api/logs") {
        return response;
    }
    
    let duration = start.elapsed();
    let content_length = response
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("0");
    
    // Robust log format with IP, User-Agent, and Response Size
    let log_line = format!("[IP: {}] [UA: {}] {} {} {} {}ms {}B", ip, user_agent, method, uri, status, duration.as_millis(), content_length);
    let _ = LOG_CHANNEL.send(log_line);
    
    response
}

async fn clean_old_logs_task() {
    loop {
        cleanup_old_logs().await;
        tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
    }
}

async fn system_status_task() {
    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    
    loop {
        interval.tick().await;
        
        // Ensure there are active subscribers before querying pool
        if LOG_BROADCAST.receiver_count() == 0 {
            continue;
        }

        let mut redis_status = "Disconnected".to_string();
        let mut cache_system_status = "Degraded".to_string();
        let mut banned_ips_count = 0;
        
        if let Some(pool) = crate::api::REDIS_POOL.get() {
            if let Ok(Ok(mut conn)) = tokio::time::timeout(std::time::Duration::from_millis(500), pool.get()).await {
                let mut cmd = redis::cmd("PING");
                let ping_fut = cmd.query_async(&mut *conn);
                if let Ok(Ok(pong)) = tokio::time::timeout(std::time::Duration::from_millis(500), ping_fut).await {
                    let pong: String = pong;
                    if pong == "PONG" {
                        redis_status = "Connected".to_string();
                        cache_system_status = "Operational".to_string();
                    }
                } else {
                    redis_status = "Error".to_string();
                }

                // Fetch ban count
                let mut keys_cmd = redis::cmd("KEYS");
                keys_cmd.arg("ban:*");
                if let Ok(Ok(keys)) = tokio::time::timeout(std::time::Duration::from_millis(500), keys_cmd.query_async::<Vec<String>>(&mut *conn)).await {
                    banned_ips_count = keys.len();
                }
            } else {
                redis_status = "Pool Exhausted/Error".to_string();
            }
        } else {
            redis_status = "Not Initialized".to_string();
        }
        
        let db_status = "N/A (Redis Only)".to_string();
        
        let status_json = serde_json::json!({
            "cache_system": cache_system_status,
            "redis": redis_status,
            "db": db_status,
            "banned_ips": banned_ips_count,
            "ddos_protection": if redis_status == "Connected" { "Active" } else { "Degraded" }
        }).to_string();
        
        let _ = LOG_BROADCAST.send(format!("[SYS_STATUS] {}", status_json));
    }
}

async fn cleanup_old_logs() {
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let yesterday = (now - Duration::days(1)).format("%Y-%m-%d").to_string();
    
    let today_filename = format!("requests_{}.log", today);
    let yesterday_filename = format!("requests_{}.log", yesterday);
    
    let log_dir = "logs";
    if let Ok(mut entries) = tokio::fs::read_dir(log_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.is_file() {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    if file_name.starts_with("requests_") && file_name.ends_with(".log") {
                        if file_name != today_filename && file_name != yesterday_filename {
                            if let Err(e) = tokio::fs::remove_file(&path).await {
                                eprintln!("Failed to delete old log file {:?}: {}", path, e);
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_logging_and_cleanup() {
        let log_dir = "logs";
        let _ = create_dir_all(log_dir).await;
        
        let now = Local::now();
        let today = now.format("%Y-%m-%d").to_string();
        let yesterday = (now - Duration::days(1)).format("%Y-%m-%d").to_string();
        let two_days_ago = (now - Duration::days(2)).format("%Y-%m-%d").to_string();
        
        let path_today = format!("{}/requests_{}.log", log_dir, today);
        let path_yesterday = format!("{}/requests_{}.log", log_dir, yesterday);
        let path_two_days_ago = format!("{}/requests_{}.log", log_dir, two_days_ago);
        
        tokio::fs::write(&path_today, b"test today").await.unwrap();
        tokio::fs::write(&path_yesterday, b"test yesterday").await.unwrap();
        tokio::fs::write(&path_two_days_ago, b"test two days ago").await.unwrap();
        
        assert!(tokio::fs::metadata(&path_today).await.is_ok());
        assert!(tokio::fs::metadata(&path_yesterday).await.is_ok());
        assert!(tokio::fs::metadata(&path_two_days_ago).await.is_ok());
        
        cleanup_old_logs().await;
        
        assert!(tokio::fs::metadata(&path_today).await.is_ok());
        assert!(tokio::fs::metadata(&path_yesterday).await.is_ok());
        assert!(tokio::fs::metadata(&path_two_days_ago).await.is_err());
        
        let _ = tokio::fs::remove_file(&path_today).await;
        let _ = tokio::fs::remove_file(&path_yesterday).await;
    }
}
