// ==UserScript==
// @name        Deezer Lyrics Sync
// @description 3/9/2025, 9:58:27 PM
// @author      Bababoiiiii
// @version     1.0
// @icon        https://www.google.com/s2/favicons?sz=64&domain=deezer.com
// @namespace   Violentmonkey Scripts
// @match       https://www.deezer.com/us/*
// @grant       GM_xmlhttpRequest
// @grant       unsafeWindow
// ==/UserScript==
// PLEASE NOTE:
// this completely fucks up the dzplayer.getCurrentSong function, so that it always returns a lyrics id (if there are no lyrics, then -1)

"use strict";
let window = unsafeWindow;

class Logger {
    constructor() {
        this.log_textarea = null;
        this.PREFIXES = Object.freeze({
            INFO: "?",
            WARN: "⚠",
            ERROR: "!",
            SUCCESS: "*",
            CONSOLE: "[Lyrics Sync]"
        });
        this.console = {
            log: (...args) => console.log(this.PREFIXES.CONSOLE, ...args),
            warn: (...args) => console.warn(this.PREFIXES.CONSOLE, ...args),
            error: (...args) => console.error(this.PREFIXES.CONSOLE, ...args),
            debug: (...args) => console.debug(this.PREFIXES.CONSOLE, ...args)
        }
        this.ui = {
            _log: (prefix, ...args) => {
                this.log_textarea.value += `[${prefix}] ${args.join(" ")}\n`;
                this.log_textarea.scrollTop = this.log_textarea.scrollHeight;
                this.console.debug(...args);
            },
            info: (...args) => this.ui._log(this.PREFIXES.INFO, ...args),
            warn: (...args) => this.ui._log(this.PREFIXES.WARN, ...args),
            error: (...args) => this.ui._log(this.PREFIXES.ERROR, ...args),
            success: (...args) => this.ui._log(this.PREFIXES.SUCCESS, ...args),
            clear: () => this.log_textarea.value = ""
        }
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function format_bytes(bytes, decimals = 2) { // chatgpt
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(decimals)} ${sizes[i]}`;
}

function generate_uuid() {
    return crypto.randomUUID();
}
function generate_hex_64bit() {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16).padStart(16, '0');
}
String.prototype.toTitleCase = function () {
    return this.replace(/\w\S*/g, function (txt) { return txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase(); });
}

class Deezer {
    constructor() {
        this.auth_token = null;
    }

    async get_auth_token() {
        const r = await fetch("https://auth.deezer.com/login/renew?jo=p&rto=c&i=c", {
            "method": "POST",
            "credentials": "include"
        });
        const resp = await r.json();
        this.auth_token = resp.jwt
        return resp.jwt;
    }

    async get_lyrics(song_id) {
        const r = await fetch("https://pipe.deezer.com/api", {
            "headers": {
                "authorization": "Bearer " + this.auth_token,
                "Content-Type": "application/json"
            },
            "body": JSON.stringify({
                "operationName": "GetLyrics",
                "variables": {
                    "trackId": song_id.toString()
                },
                "query": "query GetLyrics($trackId: String!) {\n  track(trackId: $trackId) {\n    lyrics {\n      text\n      ...SynchronizedWordByWordLines\n      ...SynchronizedLines\n    }\n  }\n}\n\nfragment SynchronizedWordByWordLines on Lyrics {\n  synchronizedWordByWordLines {\n    start\n    end\n    words {\n      start\n      end\n      word\n    }\n  }\n}\n\nfragment SynchronizedLines on Lyrics {\n  synchronizedLines {\n    lrcTimestamp\n    line\n    milliseconds\n    duration\n  }\n}\n"
            }),
            "method": "POST",
        });
        if (r.ok) {
            const data = r.json();
            if (data.errors > 0 && data.errors[0].type === "JwtTokenExpiredError") {
                this.get_auth_token();
                return this.get_lyrics(song_id);
            }
            return data;
        }
    }
}

class Lyrics_DB {
    // https://evanhahn.com/javascript-compression-streams-api-with-strings/ and https://stackoverflow.com/a/59469189
    static INDEXES = Object.freeze({
        ID: "i",
        ADDED_TIMESTAMP: "a",
        COMPRESSED_LYRICS: "l",
        TYPE: "t"
    });
    static CACHE_EXPIRATION_TIMES = Object.freeze({
        NO_LYRICS: 24*60*60*1000, // 1 day
        UNSYNCED_LYRICS: 30*24*60*60*1000, // 30 days
        SYNCED_LYRICS: 90*24*60*60*1000, // 90 days
        WORD_BY_WORD_LYRICS: 90*24*60*60*1000 // 90 days
    });
    static CACHE_TIMESTAMPS = Object.freeze({
        CUSTOM_LYRICS: Number.MAX_SAFE_INTEGER,  // we pass Number.MAX_SAFE_INTEGER because user provided lyrics should not be removed by the cache
        INSTRUMENTAL: Number.MAX_SAFE_INTEGER-1 // we use Number.MAX_SAFE_INTEGER-1 to make it more persistent in the cache than normal tracks where the lyrics might change, but not as persistent as custom lyrics
    });


    static async compress_text(str, log=true) {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        const encoded_str = new TextEncoder().encode(str)
        writer.write(encoded_str);
        writer.close();
        const compressed_array_buffer = await new Response(cs.readable).arrayBuffer();
        const compressed_str =  new Uint8Array(compressed_array_buffer);
        if (log) logger.console.debug(`Compression saved ${Math.round( (1-compressed_str.byteLength/encoded_str.byteLength)*100 )}% space (${encoded_str.byteLength} -> ${compressed_str.byteLength} = ${compressed_str.byteLength-encoded_str.byteLength} bytes)`);
        return compressed_str;
    }
    static async decompress_text(compressed_bytes) {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(compressed_bytes);
        writer.close();
        const decompressed_array_buffer = await new Response(ds.readable).arrayBuffer();
        return new TextDecoder().decode(decompressed_array_buffer);
    }

    // chatgpt more or less
    constructor() {
        this.db_name = 'lyrics_sync_cache';
        this.store_name = 'tracks';
        this.max_entries = 10000;
    }

    open_indexed_db() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.db_name, 1);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.store_name)) {
                    const store = db.createObjectStore(this.store_name, { keyPath: Lyrics_DB.INDEXES.ID }); // using id as key
                    store.createIndex('added_timestamp', Lyrics_DB.INDEXES.ADDED_TIMESTAMP, { unique: false });
                }
            };

            request.onerror = () => reject('Error opening IndexedDB');
            request.onsuccess = (event) => resolve(event.target.result);
        });
    }

    async save_to_indexed_db(id, added_timestamp, compressed_lyrics, type, opened_db=null) {
        const [i, a, l, t] = [id, added_timestamp, compressed_lyrics, type];
        const data = {
            i,
            a,
            l,
            t,
        };


        const db = opened_db || await this.open_indexed_db(this.db_name, this.store_name);

        const tx = db.transaction(this.store_name, 'readwrite');
        const store = tx.objectStore(this.store_name);

        // check the current number of entries in the store
        const count_request = store.count();
        const count = await new Promise((resolve, reject) => {
            count_request.onsuccess = () => resolve(count_request.result);
            count_request.onerror = () => reject('Error counting entries');
        });

        if (count >= this.max_entries) {
            await this.delete_oldest_entry(store);
        }

        store.put(data);

        await tx.done;
        // logger.console.debug("Data saved to cache db");
    }

    async get_from_indexed_db(id) {
        const db = await this.open_indexed_db(this.db_name, this.store_name);

        const tx = db.transaction(this.store_name, 'readonly');
        const store = tx.objectStore(this.store_name);


        const data = await new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onerror = () => reject('Error retrieving data');
            request.onsuccess = () => resolve(request.result);
        });

        if (!data) {
            // logger.console.debug('Data not found in cache db');
            return null;
        }

        // logger.console.debug('Data retrieved successfully from cache db');
        return data;
    }

    async delete_from_indexed_db(id) {
        const db = await this.open_indexed_db(this.db_name, this.store_name);
        const store = db.transaction(this.store_name, 'readwrite').objectStore(this.store_name);
        const delete_request = store.delete(id);
        await new Promise((resolve, reject) => {
            delete_request.onsuccess = resolve;
            delete_request.onerror = reject;
        });
        logger.console.debug(`Entry with ID ${id} deleted from cache db`);

    }

    async delete_oldest_entry(store) {
        const index = store.index('added_timestamp');
        const request = index.openCursor(null, 'next'); // Iterate through entries based on timestamp (ascending)

        const oldest_entry_id = await new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    resolve(cursor.primaryKey); // return the id of the oldest entry
                } else {
                    resolve(null); // no entries to delete
                }
            };
            request.onerror = () => reject('Error iterating over entries');
        });

        if (oldest_entry_id) {
            const delete_request = store.delete(oldest_entry_id);
            await new Promise((resolve, reject) => {
                delete_request.onsuccess = resolve;
                delete_request.onerror = reject;
            });
            logger.console.debug(`Oldest entry with ID ${oldest_entry_id} deleted from cache db`);
        } else {
            logger.console.debug("Oldest entry not found")
        }
    }

    async update_entry(id) { // only updates the timestamp, not the compressed data
        const entry = await this.get_from_indexed_db(id);
        return this.save_to_indexed_db(id, Date.now(), entry[Lyrics_DB.INDEXES.COMPRESSED_LYRICS], entry[Lyrics_DB.INDEXES.TYPE]);
    }

    async _fill_with_dummy_data(num_entries=10000) {
        const dummy_data = new TextEncoder().encode("Useless data aoighsüdfohgi");

        const db = await this.open_indexed_db(this.db_name, this.store_name);

        for (let i = 0; i < num_entries; i++) {
            const id = `data_id${i}`;
            await this.save_to_indexed_db(id, Date.now(), dummy_data, false, db);
            logger.console.debug(`Added entry: ${id}`);
        }

        logger.console.log(`Filled the IndexedDB with ${num_entries} entries.`);
    }
    async get_full_size() {
        const db = await this.open_indexed_db(this.db_name, this.store_name);

        const tx = db.transaction(this.store_name, 'readonly');
        const store = tx.objectStore(this.store_name);

        const entries = await new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject('Error retrieving entries');
        });

        let entry_count_ignoring_null = 0;
        let total_size = 0;
        let total_size_ignoring_null = 0;
        for (const entry of entries) {
            const id_size = new TextEncoder().encode(entry[Lyrics_DB.INDEXES.ID]).byteLength;
            const compressed_lyrics_size = entry[Lyrics_DB.INDEXES.COMPRESSED_LYRICS]?.byteLength || 8; // null is 4-8 bytes
            const timestamp_size = 8; // timestamp/numbers are 8 bytes
            const bool_size = 1; // boolean is 1 byte (idk if this is correct, but it should be around that)
            if (entry[Lyrics_DB.INDEXES.COMPRESSED_LYRICS]) {
                total_size_ignoring_null += id_size + compressed_lyrics_size + timestamp_size + bool_size;
                entry_count_ignoring_null++;
            }
            total_size += id_size + compressed_lyrics_size + timestamp_size + bool_size;
        }

        // Compute average size
        const entry_count = entries.length;
        const avg_size = entry_count > 0 ? total_size/entry_count : 0;
        const avg_size_ignoring_null = entry_count > 0 ? total_size_ignoring_null/entry_count_ignoring_null : 0;

        return {
            total_size,
            total_size_ignoring_null,
            avg_size,
            avg_size_ignoring_null,
            entry_count,
            entry_count_ignoring_null,
        };
    }

    static is_cache_expired(timestamp, type) {
        if (
            timestamp === Lyrics_DB.CACHE_TIMESTAMPS.CUSTOM_LYRICS ||
            timestamp === Lyrics_DB.CACHE_TIMESTAMPS.INSTRUMENTAL ||
            type === musixmatch.TYPES.INSTRUMENTAL
        ) {
            return false;
        }
        switch (type) {
            case musixmatch.TYPES.WORD_BY_WORD:
                return timestamp < Date.now() - Lyrics_DB.CACHE_EXPIRATION_TIMES.WORD_BY_WORD_LYRICS;
            case musixmatch.TYPES.SYNCED:
                return timestamp < Date.now() - Lyrics_DB.CACHE_EXPIRATION_TIMES.SYNCED_LYRICS;
            case musixmatch.TYPES.UNSYNCED:
                return timestamp < Date.now() - Lyrics_DB.CACHE_EXPIRATION_TIMES.UNSYNCED_LYRICS;
            default:
                return timestamp < Date.now() - Lyrics_DB.CACHE_EXPIRATION_TIMES.NO_LYRICS;
        }
    }
}


class Musixmatch {
    RESPONSES = Object.freeze({
        SUCCESS: "Request was Successful",
        INVALID_TOKEN: "Token is Invalid",
        CAPTCHA_RATELIMIT: "Ratelimited by Captcha",
        NOT_FOUND: "URL not Found",
        UNKNOWN: "Unknown Error"
    });
    URLS = Object.freeze({
        TOKEN: "https://apic.musixmatch.com/ws/1.1/token.get?app_id=android-player-v1.0&guid={0}&format=json",
        GET_TRACK: "https://apic.musixmatch.com/ws/1.1/track.get?track_isrc={0}&usertoken={1}&app_id=android-player-v1.0&format=json",
        UNSYNCED_LYRICS: "https://apic.musixmatch.com/ws/1.1/track.lyrics.get?track_isrc={0}&page_size=1&usertoken={1}&app_id=android-player-v1.0&format=json",
        SYNCED_LYRICS: "https://apic.musixmatch.com/ws/1.1/track.subtitle.get?track_isrc={0}&page_size=1&usertoken={1}&app_id=android-player-v1.0&format=json&subtitle_format={2}",
        WORD_BY_WORD_LYRICS: "https://apic.musixmatch.com/ws/1.1/track.richsync.get?track_isrc={0}&page_size=1&usertoken={1}&app_id=android-player-v1.0&format=json"
    });
    TYPES = Object.freeze({ // sorted by hierarchy
        NONE: 0,
        INSTRUMENTAL: 1,
        UNSYNCED: 2,
        SYNCED: 3,
        WORD_BY_WORD: 4,
    });


    constructor() {
        this.token = null;
    }

    static _parse_url(url, ...args) {
        return url.replace(/\{(\d+)\}/g, (_, index) => args[index]);
    }

    async make_request(url) {
        try {
            return new Promise((resolve, reject) => {
                const start = Date.now();
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    headers: {
                        'cookie': 'AWSELB=unknown',
                        'Content-Type': 'application/json',
                    },
                    onload: (response) => {
                        if (response.status === 200) {
                            const data = JSON.parse(response.responseText);
                            logger.console.debug("Got data from musixmatch:", data, "time took:", Date.now()-start, "ms");
                            const header = data.message?.header;

                            if (header?.status_code === 401) {
                                switch (header.hint) {
                                    case 'renew':
                                        resolve([this.RESPONSES.INVALID_TOKEN, data]);
                                        break;
                                    case 'captcha':
                                        resolve([this.RESPONSES.CAPTCHA_RATELIMIT, data]);
                                        break;
                                    default:
                                        resolve([this.RESPONSES.UNKNOWN, data]);
                                }
                            }
                            else if (header?.status_code === 404) {
                                resolve([this.RESPONSES.NOT_FOUND, data]);
                            }
                            else if (header?.status_code !== 200) {
                                resolve([this.RESPONSES.UNKNOWN, data]);
                            }
                            else {
                                resolve([this.RESPONSES.SUCCESS, data]);
                            }
                        }
                        else {
                            resolve([this.RESPONSES.UNKNOWN, null]);
                        }
                    },
                    onerror: (error) => {
                        console.error('Request failed', error);
                        resolve([this.RESPONSES.UNKNOWN, null]);
                    }
                });
            });
        } catch (e) {
            logger.console.error("Error in make_request:", e);
            return [this.RESPONSES.UNKNOWN, null];
        }
    };

    save_token(token) {
        if (token) config.config.musixmatch.token = token;
    }
    async retrieve_token(called_from_renew=false) {
        if (!called_from_renew) {
            logger.console.debug("Getting musixmatch token from cache");
            const token = config.config.musixmatch.token;
            if (token) {
                this.token = token;
                return token;
            }
        }
        logger.console.debug("No token found in cache/skipped cache, getting new token");

        // const url = `https://apic.musixmatch.com/ws/1.1/token.get?adv_id=${generate_uuid()}&referral=utm_source%3Dgoogle-play%26utm_medium%3Dorganic&root=1&sideloaded=1&app_id=android-player-v1.0&build_number=2024020802&guid=${generate_hex_64bit()}&lang=de_DE&model=manufacturer%2Fsamsung+brand%2Fsamsung+model%2FSM-G955N&format=json`;
        const url = `https://apic.musixmatch.com/ws/1.1/token.get?app_id=android-player-v1.0&guid=${generate_hex_64bit()}&format=json`

        const [status, data] = await this.make_request(url);

        if (status === this.RESPONSES.SUCCESS) {
            logger.console.debug("Got token:", data?.message?.body?.user_token);
            this.token = data?.message?.body?.user_token;
            this.save_token(this.token);
            return this.token;
        }
        else if (status === this.RESPONSES.CAPTCHA_RATELIMIT) {
            if (!called_from_renew) {
                if (await this.renew_token(3, 5000, 5000)) {
                    this.save_token(this.token);
                    return this.token;
                }
            }
        }
        logger.console.debug("Failed to get token")
        return null;
    }
    async renew_token(max_tries=3, delay=5000, start_delay=0) {
        await sleep(start_delay);
        for (let i = 1; i <= max_tries; i++) {
            logger.console.debug(`Renewing token (try ${i}/${max_tries})`);
            const token = await this.retrieve_token(true);
            if (token) {
                this.token = token;
                return true;
            } else {
                logger.console.debug(`Failed to renew token on try ${i}/${max_tries}. Trying again in ${delay}ms`);
            }
            await sleep(delay);
        }
        return false;
    }

    async get_track(track_isrc) {
        if (!track_isrc) {
            logger.console.debug("No track isrc provided");
            return [this.RESPONSES.NOT_FOUND, null];
        }
        const [status, data] = await this.make_request(Musixmatch._parse_url(this.URLS.GET_TRACK, track_isrc, this.token));
        if (status === this.RESPONSES.SUCCESS) {
            logger.console.debug("Got track data:", data);
            return [status, data];
        }
        return [status, null];
    }
    async which_lyric_type(track_isrc) {
        const [status, data] = await this.get_track(track_isrc);
        if (status === this.RESPONSES.SUCCESS) {
            if (data.message.body.track.instrumental === 1) {
                return this.TYPES.INSTRUMENTAL;
            }
            if (data.message.body.track.has_richsync && config.config.musixmatch.types.word_by_word) {
                return this.TYPES.WORD_BY_WORD;
            }
            if (data.message.body.track.has_subtitles && config.config.musixmatch.types.synced) {
                return this.TYPES.SYNCED;
            }
            if (data.message.body.track.has_lyrics && config.config.musixmatch.types.unsynced) {
                return this.TYPES.UNSYNCED;
            }
        }
        return this.TYPES.NONE;
    }

    async get_musixmatch_lyrics(track_isrc, type, format="lrc") {
        if (!track_isrc) {
            logger.console.debug("No track isrc provided");
            return [this.RESPONSES.NOT_FOUND, null];
        }

        if (!config.config.musixmatch.enabled) {
            logger.console.debug("Getting Lyrics from musixmatch is disabled");
            return [this.RESPONSES.NOT_FOUND, null];
        }

        const do_request = async (url_template) => {
            logger.console.debug(`Getting data for track ${track_isrc}`);
            const [status, data] = await this.make_request(Musixmatch._parse_url(url_template, track_isrc, this.token, format));
            if (status === this.RESPONSES.INVALID_TOKEN) {
                const has_new_token = await this.renew_token();
                if (has_new_token) {
                    return await do_request(Musixmatch._parse_url(url_template, track_isrc, this.token, format));
                }
                logger.console.error("Failed to get new token, stopping script");
                Hooks.toggle_hooks(false, Hooks.HOOK_INDEXES.ALL); // if we can't get a new token, we just stop this script this session basically
                return [status, null];
            }
            if (status === this.RESPONSES.NOT_FOUND) {
                logger.console.debug(`Lyrics for track ${track_isrc} not found`);
                return [status, null];
            }
            if (status === this.RESPONSES.SUCCESS) {
                logger.console.debug(`Got lyrics for track ${track_isrc}`);
                return [status, data];
            }
            else {
                logger.console.log(`Failed to get ${type} lyrics for track ${track_isrc}, status: ${status}`);
                return [status, null];
            }
        }
        const r = await do_request(type === this.TYPES.WORD_BY_WORD ? this.URLS.WORD_BY_WORD_LYRICS : type === this.TYPES.SYNCED ? this.URLS.SYNCED_LYRICS : this.URLS.UNSYNCED_LYRICS);
        logger.console.debug("Musixmatch lyrics response:", r);
        return r;
    }
}


class Lyrics_Parser {
    static lrc_to_deezer_sync_lines(data) {
        const regex = /^ *(\[(\d{2}):(\d{2})\.(\d{2})\])(.*)/;
        const offset_regex = /^ *\[offset:([-+]?\d+)\](?!\s*$)?/i;

        const lines = data.split("\n");
        const parsed_lyrics = [];

        // check if the first line is an offset line
        let offset = 0, offset_next = false;
        if (offset_regex.test(lines[0])) {
            offset = parseInt(lines.shift().match(offset_regex)[1]);
        }

        // sometimes the last line only has a timestamp to make the parsing easier.
        // we dont need it for our use case, so we remove it to allow for lines without the last line being empty
        if (!/^ *\[\d{2}:\d{2}\.\d{2}\](?!\s*$)/.test(lines[lines.length - 1])) lines.pop();

        let [lrc_timestamp, minutes, seconds, hundredths, line] = lines[0].match(regex).slice(1).map((s, i) => (i > 0 && i <= 3) ? parseInt(s) : s);
        let total_ms, duration;

        for (let i = 0; i < lines.length - 1; i++) {
            if (offset_regex.test(lines[i+1])) {
                offset_next = true;
                continue;
            }


            total_ms = minutes * 60 * 1000 + seconds * 1000 + hundredths * 10 + offset;
            const [next_lrc_timestamp, next_minutes, next_seconds, next_hundredths, next_line] = lines[i+1].match(regex).slice(1).map((s, i) => (i > 0 && i <= 3) ? parseInt(s) : s);
            duration = (next_minutes * 60 * 1000 + next_seconds * 1000 + next_hundredths * 10) - total_ms + offset;

            parsed_lyrics.push({
                lrcTimestamp: lrc_timestamp,
                line: line.replace("\\", "").trim(), // i dont think theres any need to keep the \ in the lyrics, only reason it should be there afaik is as an escape artifact
                lineTranslated: "",
                milliseconds: total_ms,
                duration: duration,
                __typename: "LyricsSynchronizedLine"
            });

            [lrc_timestamp, minutes, seconds, hundredths, line] = [next_lrc_timestamp, next_minutes, next_seconds, next_hundredths, next_line];
            if (offset_next) {
                offset_next = false;
                offset += parseInt(lines[i].match(offset_regex)[1]);
            }
        }
        parsed_lyrics.push({
            lrcTimestamp: lrc_timestamp,
            line: line.trim(),
            lineTranslated: "",
            milliseconds: total_ms + duration, // last line has no duration, so we just add up the time and duration of the previous line
            duration: 0, // no duration for the last line
            // __typename: "LyricsSynchronizedLine"
        });
        return parsed_lyrics;
    }

    static deezer_sync_lines_to_lrc(data) {
        const parsed_lyrics = [];
        for (let line of data) {
            parsed_lyrics.push(`${line.lrcTimestamp}${line.line}`);
        }
        return parsed_lyrics.join("\n");
    }

    static deezer_word_by_word_to_custom_lrc(data) {
        const parsed_lyrics = [];
        for (let line of data) {
            for (let word of line.words) {
                const start_time_lrc = `[${String(Math.floor(word.start/60000)).padStart(2, '0')}:${String(Math.floor(word.start/1000)%60).padStart(2, '0')}.${String(Math.floor(word.start%1000)).padStart(3, '0')}]`
                const end_time_lrc = `[${String(Math.floor(word.end/60000)).padStart(2, '0')}:${String(Math.floor(word.end/1000)%60).padStart(2, '0')}.${String(Math.floor(word.end%1000)).padStart(3, '0')}]`
                const lrc = `${start_time_lrc}-${end_time_lrc}${word.word} `;
                parsed_lyrics.push(lrc.trim());
            }
            parsed_lyrics.push("");
        }
        return parsed_lyrics.join("\n");
    }

    static musixmatch_word_by_word_to_deezer_word_by_word(data) {
        if (typeof data === "string") { // we store it as a string in the db to save space
            data = JSON.parse(data);
        }

        const parsed_lyrics = [];
        for (let line of data) {
            const start_time = Math.floor(line.ts*1000);
            const end_time = Math.floor(line.te*1000);
            const parsed_line = {
                start: start_time,
                end: end_time,
                words: []
            };

            for (let i = 0; i < line.l.length; i++) {
                if (line.l[i].c.trim() === "") continue;
                const part_start = Math.floor(start_time+line.l[i].o*1000);
                const part_end = (i === line.l.length-1) ? Math.floor(line.te*1000) : Math.floor(start_time+line.l[i+1].o*1000);
                parsed_line.words.push({
                    start: part_start,
                    end: part_end,
                    word: line.l[i].c,
                    // __typename: "LyricsSynchronizedWord" // not actually used by deezer, so we dont need to add it
                });
            }
            parsed_lyrics.push(parsed_line);
        }
        return parsed_lyrics
    }

    static musixmatch_word_by_word_to_custom_lrc(data) {
        // we use a custom lrc format where each word is on a new line
        // a new line is started with a line with only the [newline] tag or an empty line
        if (typeof data === "string") {
            data = JSON.parse(data);
        }

        const parsed_lyrics = [];
        for (let line of data) {
            let start_time_s = line.ts;

            for (let i = 0; i < line.l.length; i++) {
                if (line.l[i].c.trim() === "") continue;
                const start_time_ms = Math.floor((start_time_s+line.l[i].o)*1000);
                const end_time_ms = (i === line.l.length-1) ? Math.floor(line.te*1000) : Math.floor((start_time_s+line.l[i+1].o)*1000);
                const start_time_lrc = `[${String(Math.floor(start_time_ms/60000)).padStart(2, '0')}:${String(Math.floor(start_time_ms/1000)%60).padStart(2, '0')}.${String(Math.floor(start_time_ms%1000)).padStart(3, '0')}]`
                const end_time_lrc = `[${String(Math.floor(end_time_ms/60000)).padStart(2, '0')}:${String(Math.floor(end_time_ms/1000)%60).padStart(2, '0')}.${String(Math.floor(end_time_ms%1000)).padStart(3, '0')}]`
                const lrc = `${start_time_lrc}-${end_time_lrc}${line.l[i].c}`;
                parsed_lyrics.push(lrc);
            }
            parsed_lyrics.push("");
        }
        return parsed_lyrics.join("\n");
    }

    static custom_lrc_to_deezer_word_by_word(data) {
        const regex = /^ *\[(\d{2}):(\d{2})\.(\d{3})\] *- *\[(\d{2}):(\d{2})\.(\d{3})\](.*)/;
        const offset_regex = /^ *\[offset:([-+]?\d+)\]/i;

        const words = data.split("\n");
        const parsed_lyrics = [];

        let line = [];
        let offset = 0;
        for (let i = 0; i < words.length; i++) {
            let word = words[i].trim();
            if (word === "" || word.toLowerCase() === "[newline]") {
                parsed_lyrics.push({
                    start: line[0].start,
                    end: line[line.length-1].end,
                    words: line
                });
                line = [];
                continue;
            }
            else if (offset_regex.test(word)) {
                offset += parseInt(word.match(offset_regex)[1]);
                logger.console.log("Offset:", offset);
                continue;
            }
            const [start_minutes, start_seconds, start_ms, end_minutes, end_seconds, end_ms, word_text] = word.match(regex).slice(1).map((s, i) => (i < 6) ? parseInt(s) : s);
            const start = start_minutes*60*1000 + start_seconds*1000 + start_ms + offset;
            const end = end_minutes*60*1000 + end_seconds*1000 + end_ms + offset;
            line.push({
                start: start,
                end: end,
                word: word_text.trim()
            })
            if (i === words.length-1) {
                parsed_lyrics.push({
                    start: line[0].start,
                    end: line[line.length-1].end,
                    words: line
                });
            }
        }
        return parsed_lyrics;
    }
}


class Hooks {
    static HOOK_INDEXES = Object.freeze({
        FETCH: 0,
        GET_CURRENT_SONG: 1,
        HAS_LYRICS: 2,
        ALL: 3
    });

    // we use this approach to unhook to avoid unhooking hooks created after our hooks
    static is_fetch_hooked = true;
    static is_get_current_song_hooked = true;
    static is_has_lyrics_hooked = true;

    static hook_fetch(await_musixmatch_token) {
        const orig_fetch = window.fetch;
        window.fetch = async function (...args) {
            if (!Hooks.is_fetch_hooked) return orig_fetch.apply(this, args);

            try {
                if (args.length !== 2 ||
                    args[0] !== "https://pipe.deezer.com/api" ||
                    args[1].method !== "POST" ||
                    // check if the 2nd trace (after filtering out traces which were made using window.fetch (deezers script dont do that, so they must be user made and we ignore that) is in the web-app script (thats the way normal deezer scripts fetch data)
                    !(new Error()).stack.split("\n").filter(l => !l.includes("window.fetch"))[1]?.includes("app-web")
                ) {
                    return orig_fetch.apply(this, args);
                }
                const operation_name = args[1].body.match(/"operationName":\s*"(.*?)"/);
                if (!operation_name || operation_name[1] !== "GetLyrics") {
                    return orig_fetch.apply(this, args);
                }

                logger.console.debug('Catched original lyrics fetch call');

                if (dzPlayer.getCurrentSong("LYRICS_ID") === undefined) {
                    logger.console.debug("This song is probably a custom mp3 or something different which cant have lyrics");
                    return orig_fetch.apply(this, args);
                }

                const response = await orig_fetch.apply(this, args);
                const resp_json = await response.json();

                // ===== REAL HOOK START =====

                let which_deezer_lyric_type;
                if (resp_json.data.track.lyrics) {
                    if (resp_json.data.track.lyrics.synchronizedWordByWordLines) {
                        which_deezer_lyric_type = musixmatch.TYPES.WORD_BY_WORD;
                    }
                    else if (resp_json.data.track.lyrics.synchronizedLines) {
                        which_deezer_lyric_type = musixmatch.TYPES.SYNCED;
                    }
                    else {
                        which_deezer_lyric_type = musixmatch.TYPES.UNSYNCED;
                    }
                }
                else {
                    which_deezer_lyric_type = musixmatch.TYPES.NONE;
                }

                if (which_deezer_lyric_type === musixmatch.TYPES.NONE) {
                    resp_json.data.track.lyrics = {
                        copyright: dzPlayer.getArtistName(),
                        id: "-1",
                        text: "No Lyrics Found",
                        synchronizedLines: null,
                        synchronizedWordByWordLines: null,
                        writers: "",
                        __typename: "Lyrics"
                    }
                }

                const current_song_isrc = dzPlayer.getCurrentSong("ISRC");

                const cached_track_data = await lyrics_db.get_from_indexed_db(current_song_isrc);

                const is_cache_expired = cached_track_data ? Lyrics_DB.is_cache_expired(cached_track_data[Lyrics_DB.INDEXES.ADDED_TIMESTAMP], cached_track_data[Lyrics_DB.INDEXES.TYPE]) : true;
                if (!is_cache_expired) {
                    logger.console.debug("Cached data is not expired");
                    if (cached_track_data[Lyrics_DB.INDEXES.TYPE] === musixmatch.TYPES.INSTRUMENTAL) {
                        logger.console.debug("Cached song is instrumental");
                    }
                    if (cached_track_data[Lyrics_DB.INDEXES.TYPE] === musixmatch.TYPES.WORD_BY_WORD) {
                        logger.console.debug("Cached song has word by word lyrics");
                        const lyrics = await Lyrics_DB.decompress_text(cached_track_data[Lyrics_DB.INDEXES.COMPRESSED_LYRICS])
                        resp_json.data.track.lyrics.synchronizedWordByWordLines = Lyrics_Parser.custom_lrc_to_deezer_word_by_word(lyrics);
                        resp_json.data.track.lyrics.writers += (resp_json.data.track.lyrics.writers ? " | " : "") + "Word by Word Lyrics by " + (cached_track_data[Lyrics_DB.INDEXES.ADDED_TIMESTAMP] === Lyrics_DB.CACHE_TIMESTAMPS.CUSTOM_LYRICS ? "User" : "Musixmatch");
                    }
                    else if (cached_track_data[Lyrics_DB.INDEXES.TYPE] === musixmatch.TYPES.SYNCED) {
                        logger.console.debug("Cached song has synced lyrics");
                        resp_json.data.track.lyrics.synchronizedLines = Lyrics_Parser.lrc_to_deezer_sync_lines(await Lyrics_DB.decompress_text(cached_track_data[Lyrics_DB.INDEXES.COMPRESSED_LYRICS]));
                        resp_json.data.track.lyrics.writers += (resp_json.data.track.lyrics.writers ? " | " : "") + "Synced Lyrics by " + (cached_track_data[Lyrics_DB.INDEXES.ADDED_TIMESTAMP] === Lyrics_DB.CACHE_TIMESTAMPS.CUSTOM_LYRICS ? "User" : "Musixmatch");
                    }
                    else if (cached_track_data[Lyrics_DB.INDEXES.TYPE] === musixmatch.TYPES.UNSYNCED) {
                        logger.console.debug("Cached song has unsynced lyrics");
                        resp_json.data.track.lyrics.text = await Lyrics_DB.decompress_text(cached_track_data[Lyrics_DB.INDEXES.COMPRESSED_LYRICS]);
                        resp_json.data.track.lyrics.writers += resp_json.data.track.lyrics.writers += (resp_json.data.track.lyrics.writers ? " | " : "") + "Lyrics by " + (cached_track_data[Lyrics_DB.INDEXES.ADDED_TIMESTAMP] === Lyrics_DB.CACHE_TIMESTAMPS.CUSTOM_LYRICS ? "User" : "Musixmatch");
                    }
                    else {
                        logger.console.debug("Cached song has no lyrics");
                    }

                } else {
                    logger.console.debug("No cached data found or expired");
                    if (which_deezer_lyric_type === musixmatch.TYPES.WORD_BY_WORD) {
                        logger.console.debug("Song has word by word synced lyrics from deezer, getting nothing from musixmatch");
                        return new Response(JSON.stringify(resp_json), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                        });
                    }

                    await await_musixmatch_token;
                    const which_musixmatch_lyric_type = await musixmatch.which_lyric_type(dzPlayer.getCurrentSong("ISRC"));

                    if (which_deezer_lyric_type >= which_musixmatch_lyric_type) {
                        logger.console.debug("Deezer has equal/better lyrics than musixmatch, using them");
                    }
                    else if (which_musixmatch_lyric_type === musixmatch.TYPES.NONE) {
                        logger.console.debug("Song has no lyrics from musixmatch or the type is disabled");
                        await lyrics_db.save_to_indexed_db(current_song_isrc, Date.now(), null, which_musixmatch_lyric_type);
                    }
                    else if (which_musixmatch_lyric_type === musixmatch.TYPES.INSTRUMENTAL) {
                        logger.console.debug("Song is instrumental according to musixmatch");
                        await lyrics_db.save_to_indexed_db(current_song_isrc, Lyrics_DB.CACHE_TIMESTAMPS.INSTRUMENTAL, null, which_musixmatch_lyric_type);
                    }
                    else {
                        const [status, data] = await musixmatch.get_musixmatch_lyrics(current_song_isrc, which_musixmatch_lyric_type);
                        if (status === musixmatch.RESPONSES.SUCCESS) {
                            if (which_musixmatch_lyric_type === musixmatch.TYPES.WORD_BY_WORD) {
                                logger.console.debug("Song has word by word lyrics from musixmatch");
                                const lyrics = JSON.parse(data.message.body.richsync.richsync_body);
                                const parsed_lyrics = Lyrics_Parser.musixmatch_word_by_word_to_deezer_word_by_word(lyrics);
                                resp_json.data.track.lyrics.synchronizedWordByWordLines = parsed_lyrics;
                                resp_json.data.track.lyrics.writers += (resp_json.data.track.lyrics.writers ? " | " : "") + "Word by Word Lyrics by Musixmatch";
                                await lyrics_db.save_to_indexed_db(current_song_isrc, Date.now(), await Lyrics_DB.compress_text(Lyrics_Parser.musixmatch_word_by_word_to_custom_lrc(lyrics)), which_musixmatch_lyric_type);
                            }
                            else if (which_musixmatch_lyric_type === musixmatch.TYPES.SYNCED) {
                                logger.console.debug("Song has synced lyrics from musixmatch");
                                resp_json.data.track.lyrics.synchronizedLines = Lyrics_Parser.lrc_to_deezer_sync_lines(data.message.body.subtitle.subtitle_body);
                                resp_json.data.track.lyrics.writers += (resp_json.data.track.lyrics.writers ? " | " : "") + "Synced Lyrics by Musixmatch";
                                await lyrics_db.save_to_indexed_db(current_song_isrc, Date.now(), await Lyrics_DB.compress_text(data.message.body.subtitle.subtitle_body), which_musixmatch_lyric_type);
                            }
                            else if (which_musixmatch_lyric_type === musixmatch.TYPES.UNSYNCED) {
                                logger.console.debug("Song has non synced lyrics from musixmatch");
                                resp_json.data.track.lyrics.text = data.message.body.lyrics.lyrics_body;
                                resp_json.data.track.lyrics.writers += (resp_json.data.track.lyrics.writers ? " | " : "") + "Lyrics by Musixmatch";
                                await lyrics_db.save_to_indexed_db(current_song_isrc, Date.now(), await Lyrics_DB.compress_text(data.message.body.lyrics.lyrics_body), which_musixmatch_lyric_type);
                            }
                        }
                        else if (status === musixmatch.RESPONSES.NOT_FOUND) {
                            await lyrics_db.save_to_indexed_db(current_song_isrc, Date.now(), null, which_musixmatch_lyric_type);
                        }
                    }
                }

                logger.console.debug("Modified response:", resp_json);

                // ===== REAL HOOK END =====

                return new Response(JSON.stringify(resp_json), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });

            } catch (e) {
                logger.console.error("Error in fetch hook:", e);
                return orig_fetch.apply(this, args);
            }
        }
        window.fetch._modified_by_lyrics_sync_plugin = true;
    }

    static hook_get_current_song(await_musixmatch_token) {
        const orig_getcurrsong = dzPlayer.getCurrentSong;
        dzPlayer.getCurrentSong = (...args) => {
            if (!Hooks.is_get_current_song_hooked) return orig_getcurrsong.apply(dzPlayer, args);
            if (!window.fetch._modified_by_lyrics_sync_plugin) { // it reinitializes fetch sometimes, so the hook gets removed
                logger.console.log("Hooking fetch");
                this.hook_fetch(await_musixmatch_token);
            }

            let orig;
            if (args.length === 0) {
                orig = orig_getcurrsong();
                if (!orig) return orig;
                if (orig.ALB_ID !== 0 && (orig.LYRICS_ID === 0 || !orig.LYRICS_ID)) orig.LYRICS_ID = -1;
            }
            else if (args[0] === "LYRICS_ID") {
                orig = orig_getcurrsong();
                if (!orig) return orig;
                if (orig.ALB_ID !== 0 && (orig.LYRICS_ID === 0 || !orig.LYRICS_ID)) orig = -1; // if type is 0, then it is a deezer song, but it has no lyrics for some reason, so we set it to -1
                else orig = orig.LYRICS_ID;
            }
            else {
                orig = orig_getcurrsong.apply(dzPlayer, args);
            }
            return orig;
        }
        dzPlayer.getCurrentSong._modified_by_lyrics_sync_plugin = true;
    }

    static hook_has_lyrics(await_musixmatch_token) { // old legacy code which was outdated before the first version of this script got published so its still in here until the next update
        const orig_has_lyrics = dzPlayer.hasLyrics;
        dzPlayer.hasLyrics = () => {
            if (!Hooks.is_has_lyrics_hooked) return orig_has_lyrics();

            if (!window.fetch._modified_by_lyrics_sync_plugin) { // it reinitializes fetch sometimes, so the hook gets removed
                logger.console.log("Hooking fetch");
                this.hook_fetch(await_musixmatch_token);
            }
            return orig_has_lyrics();
        }
        dzPlayer.hasLyrics._modified_by_lyrics_sync_plugin = true;
    }

    static toggle_hooks(enabled, ...args) {
        for (const arg of args) {
            switch (arg) {
                case Hooks.HOOK_INDEXES.ALL:
                    Hooks.is_fetch_hooked = enabled;
                    Hooks.is_get_current_song_hooked = enabled;
                    Hooks.is_has_lyrics_hooked = enabled;
                    return;
                case Hooks.HOOK_INDEXES.FETCH:
                    Hooks.is_fetch_hooked = enabled;
                    break;
                case Hooks.HOOK_INDEXES.GET_CURRENT_SONG:
                    Hooks.is_get_current_song_hooked = enabled;
                    break;
                case Hooks.HOOK_INDEXES.HAS_LYRICS:
                    Hooks.is_has_lyrics_hooked = enabled;
                    break;
            }
        }
    }
}

class UI {
    static create_ui(await_deezer_token) {
        let parent_div = document.querySelector("#page_player > div > div.chakra-button__group")
        if (parent_div) {
            UI.create_css();
            parent_div.prepend(UI.create_main_button(await_deezer_token));
            logger.console.debug("UI created");
        } else {
            logger.console.debug("Waiting for parent");
            const observer = new MutationObserver(mutations => {
                for (let mutation of mutations) {
                    if (mutation.type === 'childList') {
                        parent_div = document.querySelector("#page_player > div > div.chakra-button__group")
                        if (parent_div) {
                            observer.disconnect();
                            if (document.querySelector("button.lyrics_sync_custom_lyrics")) return;
                            UI.create_css();
                            parent_div.prepend(UI.create_main_button(await_deezer_token));
                            logger.console.debug("UI created");
                        }
                    }
                }
            });
            observer.observe(document.body, {childList: true, subtree: true});
        }
    }

    static async _upload_files(files, status_elem) {
        if (!files.length) return;

        logger.ui.clear();
        logger.ui.info("Files selected:", Array.prototype.map.call(files, f => f.name).join(", "));

        const opened_db = await lyrics_db.open_indexed_db(lyrics_db.db_name, lyrics_db.store_name);

        let c = 0;
        for (const file of files) {
            try {
                const [isrc, ext] = file.name.split(".");

                const reader = new FileReader();
                reader.onload = async (e) => {
                    const lyrics = e.target.result.replace("\r", "");
                    const word_by_word_regex = /^ *\[\d{2}:\d{2}\.\d{3}\] *- *\[\d{2}:\d{2}\.\d{3}\].*/m
                    const line_by_line_regex = /^ *\[\d{2}:\d{2}\.\d{2}\].*/m
                    const ext_to_type = {
                        "txt": musixmatch.TYPES.UNSYNCED,
                        "lrc": musixmatch.TYPES.SYNCED,
                        "wlrc": musixmatch.TYPES.WORD_BY_WORD,
                        "lrcw": musixmatch.TYPES.WORD_BY_WORD
                    }
                    const type_to_txt = {
                        [musixmatch.TYPES.UNSYNCED]: "unsynced",
                        [musixmatch.TYPES.SYNCED]: "synced",
                        [musixmatch.TYPES.WORD_BY_WORD]: "word by word"
                    }

                    if (ext === "lrc" &&
                        (!line_by_line_regex.test(lyrics) || word_by_word_regex.test(lyrics))
                    ) {
                        logger.ui.warn(`Lyrics seem to be unsynced or word by word, but you selected synced.`);
                    }
                    else if ((ext === "wlrc" || ext === "lrcw") &&
                        !word_by_word_regex.test(lyrics)
                    ) {
                        logger.ui.warn(`Lyrics seem to be unsynced or synced, but you selected word by word.`);
                    }
                    else if (!["lrc", "lrcw", "wlrc"].includes(ext) &&
                        word_by_word_regex.test(lyrics) || line_by_line_regex.test(lyrics)) {
                        logger.ui.warn(`Lyrics seem to be synced in some way, but you selected unsynced.`);
                    }

                    const compressed_lyrics = await Lyrics_DB.compress_text(lyrics);
                    // we pass the db_objects so we can reuse the same transaction
                    await lyrics_db.save_to_indexed_db(isrc, Lyrics_DB.CACHE_TIMESTAMPS.CUSTOM_LYRICS, compressed_lyrics, ext_to_type[ext] || musixmatch.TYPES.UNSYNCED, opened_db);

                    logger.ui.info(`Saved ${isrc}${ext ? "."+ext : ""} to cache db, type: ${type_to_txt[ext_to_type[ext]] || "unsynced"}`);
                    status_elem.textContent = `Uploaded ${++c}/${files.length} Files`;
                }
                reader.onerror = e => {
                    logger.ui.error("File reading error:", e);
                };
                reader.readAsText(file, "UTF-8");

            } catch (e) {
                logger.ui.error(`Failed to upload ${file.name}: ${e}\n`);
            }
        }
        logger.ui.info("Finished uploading files");
        status_elem.textContent += " - Done";
    }

    static _start_file_upload_dialog(status_elem) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".txt,.lrc,.lrcw,.wlrc";
        input.multiple = true;
        input.style.display = "none";
        input.onchange = () => {
            const files = input.files;
            this._upload_files(files, status_elem);
        }
        input.click();
    }
    static _download_lyrics(isrc, lyrics, type) {
        const type_to_ext = {
            [musixmatch.TYPES.UNSYNCED]: "txt",
            [musixmatch.TYPES.SYNCED]: "lrc",
            [musixmatch.TYPES.WORD_BY_WORD]: "wlrc" // enhanced lrc
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([lyrics], {type: "text/plain"}));
        a.download = `${isrc}.${type_to_ext[type]}`;
        a.click();
    }


    static _Element_Factory = {
        _disable_drag_and_drop(element) {
            element.ondragover = (event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "none";
            }
            element.ondrop = (event) => {
                event.preventDefault();
            };
        },
        create_span(text, title, size=1) {
            const span = document.createElement("span");
            span.title = title;
            span.textContent = text;
            if (size) span.style.gridColumn = `span ${size}`;
            return span;
        },
        create_label(text, title, size=1) {
            const label = document.createElement("label");
            label.title = title;
            label.textContent = text;
            label.style.gridColumn = `span ${size}`;
            return label;
        },
        create_checkbox(text, title, size=1) {
            const parent_label = UI._Element_Factory.create_label(text, title, size);
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            parent_label.appendChild(checkbox);
            return [parent_label, checkbox];
        },
        create_textarea(placeholder, title, size=1) {
            const textarea = document.createElement("textarea");
            textarea.placeholder = placeholder;
            textarea.title = title;
            textarea.spellcheck = false;
            textarea.style.gridColumn = `span ${size}`;
            this._disable_drag_and_drop(textarea);
            return textarea;
        },
        create_input(placeholder, title, size=1) {
            const input = document.createElement("input");
            input.type = "text";
            input.placeholder = placeholder;
            input.title = title;
            input.style.gridColumn = `span ${size}`;
            this._disable_drag_and_drop(input);
            return input;
        },
        create_button(text, title, size=1) {
            const button = document.createElement("button");
            button.textContent = text;
            button.title = title;
            button.style.gridColumn = `span ${size}`;
            return button;
        },
        create_dropdown(options, title, size=1) {
            const select = document.createElement("select");
            select.title = title;
            select.style.gridColumn = `span ${size}`;
            for (const option of options) {
                const opt = document.createElement("option");
                opt.textContent = option;
                select.appendChild(opt);
            }
            return select;
        },
        create_border_div() {
            const div = document.createElement("div");
            div.className = "lyrics_sync_border";
            return div;
        }
    }

    static create_config_ui(await_deezer_token) {
        const container = document.createElement("div");
        container.className = "lyrics_sync_custom_lyrics_container lyrics_sync_hidden";

        const title_span = this._Element_Factory.create_span("Custom Lyrics", "Use custom lyrics, synced or not. Custom Lyrics are unaffected by cache restrictions (expiration, max track limit). Click to open the documentation.", 2);
        title_span.onclick = () => {
            window.open("https://google.com");
        }
        const reload_page_button = this._Element_Factory.create_button("", "Reloads the page to apply lyrics changes (Deezer caches lyrics on its own).", 1);
        reload_page_button.className = "lyrics_sync_reload_page_button";
        reload_page_button.textContent = "⟳";
        reload_page_button.onclick = () => window.location.reload();


        const [enabled_checkbox_label, enabled_checkbox] = this._Element_Factory.create_checkbox("Enabled", "Enable or disable this plugin.", 1);
        enabled_checkbox.checked = config.config.enabled;
        enabled_checkbox.onchange = () => {
            config.config.enabled = enabled_checkbox.checked;
            Hooks.toggle_hooks(config.config.enabled, Hooks.HOOK_INDEXES.ALL);
        }

        const [musixmatch_enabled_label, musixmatch_enabled_checkbox] = this._Element_Factory.create_checkbox("Only Cached/Custom","Disable all communication to musixmatch and only use already cached or custom lyrics.", 2);
        musixmatch_enabled_checkbox.checked = !config.config.musixmatch.enabled;
        musixmatch_enabled_checkbox.onchange = () => {
            config.config.musixmatch.enabled = !musixmatch_enabled_checkbox.checked;
        }

        const [word_by_word_enabled_label, word_by_word_enabled_checkbox] = this._Element_Factory.create_checkbox("Word", "Enable or disable word by word lyrics from musixmatch.", 1);
        word_by_word_enabled_checkbox.checked = config.config.musixmatch.types.word_by_word;
        word_by_word_enabled_checkbox.onchange = () => {
            config.config.musixmatch.types.word_by_word = word_by_word_enabled_checkbox.checked;
        }
        const [synced_enabled_label, synced_enabled_checkbox] = this._Element_Factory.create_checkbox("Line", "Enable or disable synced (line by line) lyrics from musixmatch.", 1);
        synced_enabled_checkbox.checked = config.config.musixmatch.types.synced;
        synced_enabled_checkbox.onchange = () => {
            config.config.musixmatch.types.synced = synced_enabled_checkbox.checked;
        }
        const [unsynced_enabled_label, unsynced_enabled_checkbox] = this._Element_Factory.create_checkbox("Unsynced", "Enable or disable unsynced lyrics from musixmatch.", 1);
        unsynced_enabled_checkbox.checked = config.config.musixmatch.types.unsynced;
        unsynced_enabled_checkbox.onchange = () => {
            config.config.musixmatch.types.unsynced = unsynced_enabled_checkbox.checked;
        }

        const lyrics_textarea = this._Element_Factory.create_textarea("Lyrics", "Type in the lyrics here. Synced lyrics must use the LRC format without a title. Word by Word lyrics must use the custom lrc format for this script.", 3);

        const isrc_input = this._Element_Factory.create_input("ISRC", "ISRC of the track you want to add lyrics to. Leave empty if you want to add lyrics to the currently playing track. Use google to search for the ISRC of a track or use this script to get the ISRC of the current song.", 1);

        const type_dropdown = this._Element_Factory.create_dropdown(
            ["Unsynced", "Synced", "Word by Word"],
            "Select the type of the lyrics you want to upload. Word by Word is the most accurate, but also the most time consuming to create.", 1
        );

        const submit_from_textarea_button = this._Element_Factory.create_button("Submit", "Submit the lyrics from the textarea.", 1);
        submit_from_textarea_button.onclick = async () => {
            logger.ui.clear();
            const lyrics = lyrics_textarea.value.trim();
            const isrc = isrc_input.value.trim() || dzPlayer.getCurrentSong("ISRC");

            if (!lyrics || !isrc) {
                logger.ui.warn("Lyrics are empty or song has no ISRC");
                return;
            }
            const word_by_word_regex = /^ *\[\d{2}:\d{2}\.\d{3}\] *- *\[\d{2}:\d{2}\.\d{3}\].*/m
            const line_by_line_regex = /^ *\[\d{2}:\d{2}\.\d{2}\].*/m
            if (type_dropdown.selectedIndex === 0 &&
                (word_by_word_regex.test(lyrics) || line_by_line_regex.test(lyrics))
            ) {
                logger.ui.warn(`Lyrics seem to be synced in some way, but you selected unsynced.`);
            }
            else if (type_dropdown.selectedIndex === 1 &&
                (!line_by_line_regex.test(lyrics) || word_by_word_regex.test(lyrics))
            ) {
                logger.ui.warn(`Lyrics seem to be unsynced or word by word, but you selected synced.`);
            }
            else if (type_dropdown.selectedIndex === 2 &&
                !word_by_word_regex.test(lyrics)
            ) {
                logger.ui.warn(`Lyrics seem to be unsynced or synced, but you selected word by word.`);
            }

            const compressed_lyrics = await Lyrics_DB.compress_text(lyrics);
            await lyrics_db.save_to_indexed_db(isrc, Lyrics_DB.CACHE_TIMESTAMPS.CUSTOM_LYRICS, compressed_lyrics, [musixmatch.TYPES.UNSYNCED, musixmatch.TYPES.SYNCED, musixmatch.TYPES.WORD_BY_WORD][type_dropdown.selectedIndex]);
            logger.ui.info(`Saved ${isrc} to cache db, type: ${type_dropdown.options[type_dropdown.selectedIndex].textContent}`);
        }
        const upload_files_button = this._Element_Factory.create_button("Upload Custom Lyrics", "Upload lyrics from files. The name of the file must be the ISRC of the track. The extension must be .lrc if the lyrics are synced using the LRC format. If the lyrics are word by word synced using the custom lrc format, then the extension must either be .lrcw or .wlrc. All other file types are treated as raw text lyrics.", 3);
        upload_files_button.onclick = () => this._start_file_upload_dialog(upload_files_button);

        // === song info start ===
        const song_info_title_span = this._Element_Factory.create_span("Song Info", "Information about the currently playing song", 1);
        const reload_song_info_button = this._Element_Factory.create_button("", "Reload the song info", 1);
        reload_song_info_button.className = "lyrics_sync_reload_song_info_button";
        reload_song_info_button.textContent = "⟳";

        const song_info_container_div = document.createElement("div");
        song_info_container_div.className = "lyrics_sync_song_info_container";
        song_info_container_div.style.gridColumn = "span 3";

        const isrc_label = this._Element_Factory.create_label("ISRC: ", "The ISRC of a song is a standardized unique identifier of a song. We use it to tell other Platforms what song we mean.", 3);
        const isrc_span = this._Element_Factory.create_span("Not fetched", "", null);
        isrc_label.appendChild(isrc_span);

        const has_lyrics_label = this._Element_Factory.create_label("Lyrics: ", "Format: Has Lyrics (Is Synced) - Source. Note that this status does not retrieve the lyrics from Musixmatch, it only checks for cached ones.", 3);
        const has_lyrics_span = this._Element_Factory.create_span("Not fetched", "", null);
        has_lyrics_label.appendChild(has_lyrics_span);

        const has_lyrics = async (isrc) => {
            const cached_track_data = await lyrics_db.get_from_indexed_db(isrc);
            if (cached_track_data) {
                const lyrics = cached_track_data[Lyrics_DB.INDEXES.COMPRESSED_LYRICS];
                if (lyrics) {
                    logger.ui.info("Lyrics found in cache.");
                    return [lyrics, cached_track_data[Lyrics_DB.INDEXES.TYPE], cached_track_data[Lyrics_DB.INDEXES.ADDED_TIMESTAMP] === Lyrics_DB.CACHE_TIMESTAMPS.CUSTOM_LYRICS ? "Custom" : "Musixmatch"];
                } else {
                    logger.ui.info("Song was cached, but had no lyrics.");
                    return [null, musixmatch.TYPES.NONE, "Cache"];
                }
            }
            else {
                logger.ui.info("Song was not cached, getting deezer lyrics.");

                const lyrics_id = dzPlayer.getCurrentSong("LYRICS_ID")
                if (lyrics_id === -1) { // we hook the getcurrentfetch call and return -1 for the lyricsid if the song has no lyrics, it doesnt exist for song without lyrics by default
                    logger.ui.info("No lyrics found in deezer");
                    return [null, musixmatch.TYPES.NONE, "Deezer"];
                }

                await await_deezer_token;

                const data = await deezer.get_lyrics(dzPlayer.getSongId());
                if (!data.data.track.lyrics) {
                    logger.ui.info("No lyrics found in deezer");
                    return [null, musixmatch.TYPES.NONE, "Deezer"];
                }
                if (data.data.track.lyrics.synchronizedWordByWordLines) {
                    logger.ui.info("Song has word by word synced lyrics from deezer");
                    return [data.data.track.lyrics.synchronizedWordByWordLines, musixmatch.TYPES.WORD_BY_WORD, "Deezer"];
                }
                if (data.data.track.lyrics.synchronizedLines) {
                    logger.ui.info("Song has synced lyrics from deezer");
                    return [data.data.track.lyrics.synchronizedLines, musixmatch.TYPES.SYNCED, "Deezer"];
                }
                logger.ui.info("Song has unsynced lyrics from deezer");
                return [data.data.track.lyrics.text, musixmatch.TYPES.UNSYNCED, "Deezer"];
            }
        }

        reload_song_info_button.onclick = async () => {
            logger.ui.clear();
            let isrc = dzPlayer.getCurrentSong("ISRC");
            let lyrics, type, source;
            if (!isrc) {
                lyrics = type = source = null;
                isrc = "Unkown"
                logger.ui.warn("No ISRC found for current song");
            } else {
                [lyrics, type, source] = await has_lyrics(isrc);
            }
            const type_to_text = {
                [musixmatch.TYPES.NONE]: "No Lyrics",
                [musixmatch.TYPES.WORD_BY_WORD]: "Word by Word",
                [musixmatch.TYPES.SYNCED]: "Synced",
                [musixmatch.TYPES.UNSYNCED]: "Unsynced",
            }

            isrc_span.textContent = isrc;
            if (lyrics) {
                has_lyrics_span.textContent = "Yes";
                has_lyrics_span.textContent += " (" + type_to_text[type] + ")";
                has_lyrics_span.textContent += " - " + source;
            }
            else {
                has_lyrics_span.textContent = "No";
            }
            return [isrc, type, lyrics, source];
        }

        song_info_container_div.append(isrc_label, has_lyrics_label);
        // === song info end ===

        const export_lyrics_button = this._Element_Factory.create_button("Export", "Export the lyrics of the current song which Deezer would use. (Hierarchy: Word by Word Synced > Line by Line Synced > Unsynced and Custom > Deezer > Musixmatch. If it's synced or not has higher priority than the source)", 1);
        export_lyrics_button.onclick = async () => {
            const [isrc, type, lyrics, source] = await reload_song_info_button.onclick();

            if (lyrics) {
                let to_export;
                if (source === "Deezer") {
                    if (type === musixmatch.TYPES.WORD_BY_WORD) {
                        to_export = Lyrics_Parser.deezer_word_by_word_to_custom_lrc(lyrics);
                    }
                    else if (type === musixmatch.TYPES.SYNCED) {
                        to_export = Lyrics_Parser.deezer_sync_lines_to_lrc(lyrics);
                    }
                    else if (type === musixmatch.TYPES.UNSYNCED) {
                        to_export = lyrics;
                    }
                }
                else {
                    if (type !== musixmatch.TYPES.NONE) to_export = await Lyrics_DB.decompress_text(lyrics);
                }

                if (!to_export) {
                    logger.ui.info("No lyrics to export");
                    return;
                }

                if (config.config.export_to_clipboard_or_file === "clipboard") {
                    logger.ui.info("Copying lyrics to clipboard");
                    navigator.clipboard.writeText(to_export);
                } else {
                    logger.ui.info("Downloading lyrics");
                    this._download_lyrics(isrc, to_export, type);
                }
            }
        }

        const [export_to_clipboard_label, export_to_clipboard_checkbox] = this._Element_Factory.create_checkbox("Clipboard", "If checked, the export button copies the lyrics to your clipboard, otherwise it downloads them.", 1);
        export_to_clipboard_checkbox.checked = config.config.export_to_clipboard_or_file === "clipboard";
        export_to_clipboard_checkbox.onchange = () => {
            config.config.export_to_clipboard_or_file = export_to_clipboard_checkbox.checked ? "clipboard" : "file";
        }

        const delete_cache_button = this._Element_Factory.create_button("Invalidate", "Clear the cache of the current song. This will delete custom lyrics.", 1);
        delete_cache_button.onclick = async () => {
            logger.ui.clear();
            const isrc = dzPlayer.getCurrentSong("ISRC");
            if (!isrc) {
                logger.ui.warn("No ISRC found for current song");
                return;
            }
            const cached_track_data = await lyrics_db.get_from_indexed_db(isrc);
            if (!cached_track_data) {
                logger.ui.warn("No cache found for current song");
                return;
            }
            await lyrics_db.delete_from_indexed_db(isrc);
            logger.ui.info("Deleted cache of current song");
        }

        const log_textarea = document.createElement("textarea");
        log_textarea.placeholder = "Log";
        log_textarea.spellcheck = false;
        log_textarea.readOnly = true;
        log_textarea.style.gridColumn = "span 3";
        logger.log_textarea = log_textarea;

        const drop_zone_div = document.createElement("div");
        drop_zone_div.className = "lyrics_sync_drop_zone lyrics_sync_hidden";
        drop_zone_div.textContent = "Drop Lyric Files Here";
        container.ondragenter = e => {
            if (e.dataTransfer.types.includes("Files")) drop_zone_div.classList.remove("lyrics_sync_hidden");
            e.preventDefault();
        }
        drop_zone_div.ondragover = e => e.preventDefault();
        drop_zone_div.ondrop = e => {
            this._upload_files(e.dataTransfer.files, upload_files_button);
            drop_zone_div.classList.add("lyrics_sync_hidden");
            e.preventDefault();
        }
        drop_zone_div.ondragleave = (e) => {
            drop_zone_div.classList.add("lyrics_sync_hidden");
            e.preventDefault();
        }

        container.append(title_span, reload_page_button, enabled_checkbox_label, musixmatch_enabled_label, word_by_word_enabled_label, synced_enabled_label, unsynced_enabled_label, lyrics_textarea, isrc_input, type_dropdown, submit_from_textarea_button, this._Element_Factory.create_border_div(), upload_files_button, song_info_title_span, reload_song_info_button, song_info_container_div, export_to_clipboard_label, export_lyrics_button, delete_cache_button, log_textarea, drop_zone_div);
        return container;
    }

    static create_main_button(await_deezer_token) {
        const button = document.createElement("button");
        button.title = "Use custom lyrics.";
        button.className = "lyrics_sync_custom_lyrics";
        button.innerHTML = `
        <svg viewBox="-140 -120 720 720" aria-hidden="true">
            <path d="m445.767 308.42-53.374-76.49V97.241c0-6.669-2.604-12.94-7.318-17.645L312.787 7.301A24.8 24.8 0 0 0 295.149 0H77.597C54.161 0 35.103 19.066 35.103 42.494V425.68c0 23.427 19.059 42.494 42.494 42.494h199.021c1.902 2.54 3.915 5 6.232 7.205 10.033 9.593 23.547 15.576 38.501 15.576h34.363c14.936 0 28.483-5.982 38.517-15.576 11.693-11.159 17.348-25.825 17.348-40.29v-40.06c16.216-3.418 30.114-13.866 37.91-28.811a55.66 55.66 0 0 0-3.722-57.798M170.095 414.872H87.422V53.302h175.681v46.752c0 16.655 13.547 30.209 30.209 30.209h46.76v66.377h-.255v.039c-17.685-.415-35.529 7.285-46.934 23.46l-61.586 88.28c-11.965 17.134-13.387 39.284-3.722 57.799 7.795 14.945 21.692 25.393 37.91 28.811v19.842h-95.39zm240.221-69.101c-2.03 3.866-5.99 6.271-10.337 6.271h-32.591v83.048a11.68 11.68 0 0 1-11.659 11.662h-34.396a11.68 11.68 0 0 1-11.662-11.662v-83.048h-32.59c-4.346 0-8.308-2.405-10.336-6.271a11.62 11.62 0 0 1 .783-12.07l61.424-88.064a11.7 11.7 0 0 1 9.57-4.984h.017c3.802 0 7.38 1.861 9.568 4.984l61.427 88.064a11.62 11.62 0 0 1 .782 12.07"/>
        </svg>`

        const container = this.create_config_ui(await_deezer_token);
        document.querySelector("#page_player > div > div.chakra-button__group").insertBefore(container, button.nextSibling);

        button.onclick = () => {
            container.classList.toggle("lyrics_sync_hidden");
            button.classList.toggle("active");
        }

        return button;
    }

    static create_css() {
        const css = `
            .lyrics_sync_hidden {
                display: none !important;
            }

            button.lyrics_sync_custom_lyrics {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                position: relative;
                min-height: var(--tempo-sizes-size-m);
                min-width: var(--tempo-sizes-size-m);
                color: var(--tempo-colors-text-neutral-primary-default);
                background: var(--tempo-colors-transparent);
                border-radius: var(--tempo-radii-full);
            }
            button.lyrics_sync_custom_lyrics:hover {
                background: var(--tempo-colors-background-neutral-tertiary-hovered);
                color: var(--tempo-colors-text-neutral-primary-hovered);
            }
            button.lyrics_sync_custom_lyrics.active {
                color: var(--tempo-colors-icon-accent-primary-default);
            }
            button.lyrics_sync_custom_lyrics > svg {
                width: 24px;
                height: 24px;
                fill: currentcolor;
            }

            div.lyrics_sync_custom_lyrics_container {
                width: 300px;
                max-height: 550px;
                position: absolute;
                bottom: 0;
                right: 0;
                transform: translate(-100px, -63px);
                margin: 0px;
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 3fr));
                gap: 10px;
                overflow: auto;
                background-color: var(--tempo-colors-background-neutral-secondary-default);
                border-radius: var(--tempo-radii-s);
                box-shadow: rgba(0, 0, 0, 0.4) 0px 0px 25px 10px, rgba(0, 0, 0, 0.04) 0px 10px 10px -5px;
                z-index: 9999;
                padding: 12px;
            }
            div.lyrics_sync_custom_lyrics_container div.lyrics_sync_border {
                grid-column: span 3;
                border-bottom: 1px solid var(--color-neutral-main);
            }

            div.lyrics_sync_drop_zone {
                position: absolute;
                inset: 0;
                display: flex;
                justify-content: center;
                align-items: center;
                text-align: center;
                opacity: 95%;
                font-size: 20px;
                font-weight: bold;
                background-color: var(--tempo-colors-background-neutral-secondary-default);
            }

            div.lyrics_sync_custom_lyrics_container > span {
                font-size: 18px;
                font-weight: bold;
                height: 20px;
            }

            div.lyrics_sync_custom_lyrics_container textarea,
            div.lyrics_sync_custom_lyrics_container input[type="text"],
            div.lyrics_sync_custom_lyrics_container button,
            div.lyrics_sync_custom_lyrics_container select {
                background-color: var(--tempo-colors-background-neutral-tertiary-default);
                border: 1px var(--tempo-colors-border-neutral-primary-default) solid;
                border-radius: var(--tempo-radii-s);
            }

            div.lyrics_sync_custom_lyrics_container textarea {
                height: 90px;
                padding: 5px 5px;
                font-size: 11px;
                overflow: auto;
                white-space: pre;
                resize: none;
                scrollbar-width: thin;
            }

            div.lyrics_sync_custom_lyrics_container input[type="text"],
            div.lyrics_sync_custom_lyrics_container label,
            div.lyrics_sync_custom_lyrics_container button,
            div.lyrics_sync_custom_lyrics_container select {
                height: 25px;
            }

            div.lyrics_sync_custom_lyrics_container input[type="text"],
            div.lyrics_sync_custom_lyrics_container button {
                padding: 0px 5px;
            }

            div.lyrics_sync_custom_lyrics_container input[type="text"],
            div.lyrics_sync_custom_lyrics_container select {
                border-radius: 5px;
                font-size: 12px;
            }

            div.lyrics_sync_custom_lyrics_container button {
                font-size: 15px;
            }
            div.lyrics_sync_custom_lyrics_container button:active {
                background-color: var(--color-grey-500);
            }

            div.lyrics_sync_custom_lyrics_container label {
                align-content: center;
                font-size: 14px;
                color: var(--tempo-colors-neutral-70);
            }

            div.lyrics_sync_custom_lyrics_container label > input[type="checkbox"] {
                margin-left: 5px;
            }

            div.lyrics_sync_custom_lyrics_container input:hover,
            div.lyrics_sync_custom_lyrics_container textarea:hover,
            div.lyrics_sync_custom_lyrics_container button:hover,
            div.lyrics_sync_custom_lyrics_container select:hover {
                background-color: var(--tempo-colors-background-neutral-tertiary-hovered);
            }
            div.lyrics_sync_custom_lyrics_container textarea:focus,
            div.lyrics_sync_custom_lyrics_container input:focus,
            div.lyrics_sync_custom_lyrics_container select:focus {
                border-color: var(--tempo-colors-border-neutral-primary-focused);
            }

            div.lyrics_sync_custom_lyrics_container button.lyrics_sync_reload_song_info_button,
            div.lyrics_sync_custom_lyrics_container button.lyrics_sync_reload_page_button {
                background-color: transparent;
                border: none;
                font-weight: bold;
                font-size: 20px;
            }
            div.lyrics_sync_custom_lyrics_container button.lyrics_sync_reload_song_info_button:hover,
            div.lyrics_sync_custom_lyrics_container button.lyrics_sync_reload_page_button:hover {
                transform: scale(1.2);
            }
            div.lyrics_sync_custom_lyrics_container button.lyrics_sync_reload_song_info_button {
                text-align: left;
                transform-origin: left;
            }
            div.lyrics_sync_custom_lyrics_container button.lyrics_sync_reload_page_button {
                text-align: right;
                transform-origin: right;
            }


            div.lyrics_sync_custom_lyrics_container div.lyrics_sync_song_info_container {
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 3fr));
                gap: 5px;
            }
            div.lyrics_sync_custom_lyrics_container div.lyrics_sync_song_info_container label {
                font-size: 14px;
                color: var(--tempo-colors-neutral-50);
            }
            div.lyrics_sync_custom_lyrics_container div.lyrics_sync_song_info_container label > span {
                font-size: 12px;
                color: var(--tempo-colors-neutral-80);
                cursor: text;
                user-select: text;
                padding-left: 5px;
            }
            div.lyrics_sync_custom_lyrics_container div.lyrics_sync_song_info_container > button {
                font-size: 14px;
            }
        `;
        const style = document.createElement("style");
        style.type = "text/css";
        style.textContent = css;
        document.querySelector("head").appendChild(style);
    }
}

class Config {
    constructor() {
        this.config = this.setter_proxy(this.retrieve());
    }

    retrieve() {
        return JSON.parse(localStorage.getItem("lyrics_sync_config")) || {
            enabled: true,
            export_to_clipboard_or_file: "file",
            musixmatch: {
                token: null,
                enabled: true,
                types: {
                    word_by_word: true,
                    synced: true,
                    unsynced: true
                }
            }
        };
    }
    save() {
        localStorage.setItem("lyrics_sync_config", JSON.stringify(this.config));
    }

    setter_proxy(obj) {
        return new Proxy(obj, {
            set: (target, key, value) => {
                target[key] = value;
                this.save();
                return true;
            },
            get: (target, key) => {
                if (typeof target[key] === 'object' && target[key] !== null) {
                    return this.setter_proxy(target[key]); // Ensure nested objects are also proxied
                }
                return target[key];
            }
        });
    }

}

const logger = new Logger();
logger.console.debug("Creating All Class Instances");
const config = new Config();
const lyrics_db = new Lyrics_DB();
const musixmatch = new Musixmatch();
const deezer = new Deezer();

(async function main() {
    const await_deezer_token = deezer.get_auth_token();
    logger.console.log("Creating UI");
    UI.create_ui(await_deezer_token);

    const await_musixmatch_token = musixmatch.retrieve_token();

    const db_stats = await lyrics_db.get_full_size()
    logger.console.log(`
    Cache stats:
    ------------
    Total size: ${format_bytes(db_stats.total_size)}
    Total size of entries with lyrics: ${format_bytes(db_stats.total_size_ignoring_null)}
    Average size: ${format_bytes(db_stats.avg_size)}
    Average size with lyrics: ${format_bytes(db_stats.avg_size_ignoring_null)}
    Entry count: ${db_stats.entry_count}
    Entry count with lyrics: ${db_stats.entry_count_ignoring_null}
    `);


    logger.console.log("Hooking dzplayer (getCurrentSong, hasLyrics)");
    const wait_for_dz_player_interval = setInterval(() => {
        if (window.dzPlayer) {
            clearInterval(wait_for_dz_player_interval);
            Hooks.toggle_hooks(config.config.enabled, Hooks.HOOK_INDEXES.ALL);
            Hooks.hook_get_current_song(await_musixmatch_token);
            // Hooks.hook_has_lyrics(await_musixmatch_token);
        }
    }, 100);
})();
