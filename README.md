# Deezer-Lyrics-Sync
Deezer userscript which allows you to use Musixmatch's or your own lyrics in Deezer. Support unsynced, line by line synced and word by word synced lyrics.
Tested on Brave w/ Violentmonkey.

## Installation
Download the userscipt js file and load it with your userscript manager.

## Usage
Retrieves lyrics from Musixmatch whenever you retrieve lyrics from Deezer in the background, no user interaction.\
Adds a button in the music player bar which allows you to add custom lyrics and configure the script. Each option has a description on hover.

![image](https://github.com/user-attachments/assets/d9e0b2e8-e2bd-45d4-ae35-2829fdabb114)

## Cache
This script uses a cache to story Musixmatch/custom lyrics.\
The cache has a max item limit of 10,000 entries. If that is exceeded, the oldest entry gets deleted.\
Custom Lyrics are always treated as new entries. This means they **can** get deleted, but really only when you have 10,000 custom lyric entries.\
Similar thing goes for instrumental songs. They are always treated as the newest entries besides custom lyrics.\
All other entries are treated normally and have expiration times which means the script re-retrieves the lyrics from musixmatch after X time.\
The times are:
  - 1 day if the song had no lyrics
  - 30 days if the song had unsynced lyrics
  - 90 days if the song had line by line or word by word synced lyrics

### Storage
The cache obviously takes up storage:
  - Each entry for songs without entries takes up basically 0 storage.
  - Each entry with unsynced lyrics takes ~0.5KB of storage
  - Each entry with line by line synced lyrics takes ~1KB of storage
  - Each entry with word by word synced lyrics takes ~2-3KB of storage

Depending on what you listen to, the cache would take up between 5MB and 30MB of storage approximately.
