# HqAudio API

![GitHub License](https://img.shields.io/github/license/suvojeet-sengupta/hqaudio-api)
![GitHub Release](https://img.shields.io/github/v/release/suvojeet-sengupta/hqaudio-api)

An Unofficial API for downloading high-quality songs, albums, playlists, and more from [HqAudio](https://hqaudio.com). Fully migrated to Rust for superior performance and memory safety.

## Documentation

Check out the [API documentation](https://hqaudio.suvojeetsengupta.in/docs) for detailed information on how to use the API.

## Changelog

For a detailed list of changes, see the [CHANGELOG](CHANGELOG.md).

## Running Locally

### Using Docker (Recommended)

1. Clone the repository:

   ```sh
   git clone https://github.com/suvojeet-sengupta/hqaudio-api
   cd hqaudio-api
   ```

2. Start the application:

   ```sh
   docker-compose up
   ```

---

### Manually

> [!NOTE]
> You need the [Rust toolchain](https://www.rust-lang.org/tools/install) installed.

1. Clone the repository:

   ```sh
   git clone https://github.com/suvojeet-sengupta/hqaudio-api
   cd hqaudio-api
   ```

2. Configure environment variables (optional):

   Copy the template environment file and customize it:
   ```sh
   cp .env.example .env
   ```

3. Launch the development server:

   ```sh
   cd rust
   cargo run
   ```

The server will start on `http://0.0.0.0:3000` (or the port defined in your `.env` file).

## Credits

- **Sumit Kohle**: Original author.
- **Suvojeet Sengupta**: Migrated the entire backend to Rust, implemented advanced caching and rate limiting, added robust security and DDoS protection, and built the real-time WebSocket logs and monitoring dashboard.

## License

This project is distributed under the [MIT License](https://opensource.org/licenses/MIT). For more information, see the [LICENSE](LICENSE) file included in this repository.
