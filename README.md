# Deezer-Lyrics-Sync
Deezer userscript which allows you to use Musixmatch's or your own lyrics in Deezer. Support unsynced, line by line synced and word by word synced lyrics.
Tested on Brave w/ Violentmonkey.\
Also supports the Desktop application thanks to [DeezMod](https://github.com/bertigert/DeezMod)

## Installation
[Download](https://github.com/bertigert/Deezer-Lyrics-Sync/blob/main/lyrics_sync.user.js) the userscipt js file and load it with your userscript manager.

## Usage
Retrieves lyrics from Musixmatch whenever you retrieve lyrics from Deezer in the background, no user interaction.\
Adds a button in the music player bar which allows you to add custom lyrics and configure the script. Each option has a description on hover.

![image](https://github.com/user-attachments/assets/d9e0b2e8-e2bd-45d4-ae35-2829fdabb114)

## Logic
Hierarchy:
  - Word By Word Sync > Line by Line Sync > Unsynced > No lyrics
  - Custom Lyrics > Deezer > Musixmatch

> The type of lyric has higher priority than the source.

This means that whenever Deezer has better/equal lyrics than/to Musixmatch, Deezer's lyrics get used. Otherwise we use Musixmatch's lyrics, if they exist.\
This also means that even when you have custom lyrics in the cache, if Deezer has lyrics of a better type, Deezer's get used. However, if you have custom lyrics, we never ask Musixmatch for lyrics.

## Formats
Unsynced Lyrics are just raw text with each line being seperated by a newline.\
Line by Line Lyrics use the standard LRC format where each line is one line of text with a timestamp at the beginning.\
Word by Word Lyrics use a custom LRC format where each line is it's own word:

```
[offset:5000]
[00:00.659]-[00:00.869] Don't
[00:00.939]-[00:01.089] think
[00:01.119]-[00:01.169] I'll
[00:01.199]-[00:01.409] ever
[00:01.488]-[00:01.639] go
[00:01.788]-[00:05.608] home

[00:06.718]-[00:06.818] The
[00:06.868]-[00:07.098] house
[offset:-5000]
[00:07.128]-[00:07.158] is
[00:07.198]-[00:07.684] empty
[newline]
[00:08.739]-[00:08.749] But
[00:08.755]-[00:08.762] I
```
Each line for a word has the format `[startMinutes:startSeconds.startMilliseconds]-[endMinutes:endSeconds.endMilliseconds] WORD`\
Note the use of milliseconds instead of hundredths as with the normal LRC format.\
Each full line of the lyrics must be seperated by either an empty line or a line with `[newline]`.

### Offsets
Offsets are supported for both Line by Line and Word by Word. They can be used to adjust the timings of multiple lines without needing to manually edit every timestamp.\
An offset must be specified by a line with `[offset:<offsetinms>]`.\
The offset is a global counter meaning it is additive and applies to every line following the offsets definition.\
In the example above we specify an offset of `+5000ms` at the beginning of the song. This means that the lyrics are delayed 5 seconds from that point on. We then later add an offset of `-5000ms`, which in this case cancels out the delay from before, meaning that the lyrics are now normal again.

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

Depending on what you listen to, the full cache would take up between 5MB and 30MB of storage approximately.

## Links
[GitHub](https://github.com/bertigert/Deezer-Lyrics-Sync)

[GreazyFork](https://greasyfork.org/en/scripts/529734)
