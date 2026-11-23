import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, ListVideo, Play, Pause, Film, Trash2, Layout, Monitor, Grid, List, Globe, Folder, Upload, Type, X, Clock, Plus, Search, ChevronDown, MoreHorizontal, SkipBack, SkipForward, Repeat, Volume2, VolumeX } from 'lucide-react';
import { authUrl } from '../auth';
import { ensureMediaIds, registerLocalMedia } from '../utils/localMedia';
import { isCanvaUrl, normalizeCanvaUrl, resolveDeckUrl } from '../utils/presentation';
import { deferUntilIdle, readLocalStorageArraySafe, useDebouncedLocalStorageEffect, useThrottledCallback } from '../utils/performance';
import { scheduleTick, localDateKey, formatCountdown, formatClock12, formatDays } from '../utils/schedule';

const WEEKDAY_OPTIONS = [['S', 0], ['M', 1], ['T', 2], ['W', 3], ['T', 4], ['F', 5], ['S', 6]];

const MEDIA_PLAYLIST_KEY = 'bc_media_playlist_v1';
const PHOTO_PLAYLIST_KEY = 'bc_photo_playlist_v1';
const SCHEDULED_PLAYS_KEY = 'bc_scheduled_plays_v1';
const VIEW_MODE_KEY = 'bc_media_view_mode';
const MEDIA_FOLDERS_KEY = 'bc_media_folders_v1';
const ACTIVE_FOLDER_KEY = 'bc_media_active_folder_v1';
// Legacy key: photos now share the video folders (see mergeFolderLists below).
const PHOTO_FOLDERS_KEY = 'bc_photo_folders_v1';
const DEFAULT_FOLDER_ID = 'default';
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

const DEFAULT_FOLDERS = [{ id: DEFAULT_FOLDER_ID, name: 'Unsorted' }];
// Display order of the combined (videos + photos) library, as stable item keys.
const LIBRARY_ORDER_KEY = 'bc_media_library_order_v1';
const videoLibraryKey = (item) => `v:${item.type}:${item.type === 'youtube' ? item.id : item.path}`;
const photoLibraryKey = (item) => `p:${item.type}:${item.path}`;

// Videos and photos used to keep separate folder lists. They now share one: photo folders
// are folded into the video folders by name (or added), and photo items re-pointed at the
// shared folder. Safe to run on every load — already-merged data comes back unchanged.
const mergeFolderLists = (mediaFolders, photoFolders, photos) => {
    const folders = [...mediaFolders];
    if (!folders.some(f => f.id === DEFAULT_FOLDER_ID)) folders.unshift(DEFAULT_FOLDERS[0]);
    const idMap = new Map();
    for (const pf of photoFolders) {
        const name = (pf.name || '').trim().toLowerCase();
        const match = folders.find(f => f.id === pf.id || (f.name || '').trim().toLowerCase() === name);
        if (match) idMap.set(pf.id, match.id);
        else { folders.push(pf); idMap.set(pf.id, pf.id); }
    }
    const known = new Set(folders.map(f => f.id));
    let changed = false;
    const remapped = photos.map(p => {
        const fid = p.folderId || DEFAULT_FOLDER_ID;
        const target = known.has(fid) ? fid : (idMap.get(fid) || DEFAULT_FOLDER_ID);
        if (target === fid) return p;
        changed = true;
        return { ...p, folderId: target };
    });
    return { folders, photos: changed ? remapped : photos };
};

const getFileName = (filePath = '') => filePath.split(/[/\\]/).pop() || 'Local file';
const getExtension = (filePath = '') => getFileName(filePath).split('.').pop()?.toLowerCase() || '';
const isVideoPath = (filePath = '') => VIDEO_EXTENSIONS.has(getExtension(filePath));
const isImagePath = (filePath = '') => IMAGE_EXTENSIONS.has(getExtension(filePath));
const getFolderIdForNewItem = (activeFolderId) => activeFolderId === 'all' ? DEFAULT_FOLDER_ID : activeFolderId;

export default function MediaPanel({ socket, showParticleOverlayControls = false, isActive = true }) {
    const [playlist, setPlaylist] = useState([]);
    const [photoPlaylist, setPhotoPlaylist] = useState([]);

    const [youtubeUrl, setYoutubeUrl] = useState('');
    const [youtubePlaylistUrl, setYoutubePlaylistUrl] = useState('');
    const [playlistLimit, setPlaylistLimit] = useState(''); // newest N to fetch; blank = all
    const [webpageUrl, setWebpageUrl] = useState('');
    
    const [canvaUrl, setCanvaUrl] = useState('');
    const [canvaName, setCanvaName] = useState('');

    const [mediaData, setMediaData] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isMuted, setIsMuted] = useState(false);
    const [loop, setLoop] = useState(false);
    const [autoNext, setAutoNext] = useState(false);
    const [photoLoop, setPhotoLoop] = useState(false);
    const [photoAutoNext, setPhotoAutoNext] = useState(false);
    const [photoInterval, setPhotoInterval] = useState(5);
    const [isPhotoLive, setIsPhotoLive] = useState(false);
    const [currentPhotoIdx, setCurrentPhotoIdx] = useState(-1);

    const [isFetchingYt, setIsFetchingYt] = useState(false);
    const [isFetchingPlaylist, setIsFetchingPlaylist] = useState(false);

    // YouTube playlist import picker: fetched videos (or null when closed) + selected ids.
    const [playlistPickerItems, setPlaylistPickerItems] = useState(null);
    const [selectedVideoIds, setSelectedVideoIds] = useState(() => new Set());

    // Scheduled Plays: auto-play a library item at a clock time (once/daily).
    const [scheduledPlays, setScheduledPlays] = useState([]);
    const [scheduleNow, setScheduleNow] = useState(() => new Date());
    const [newScheduleIdx, setNewScheduleIdx] = useState('');
    const [newScheduleTime, setNewScheduleTime] = useState('');
    const [newScheduleMode, setNewScheduleMode] = useState('once');
    const [newScheduleDays, setNewScheduleDays] = useState([]);

    // Particle States
    const [particlesEnabled, setParticlesEnabled] = useState(false);
    const [particleType, setParticleType] = useState('dust'); // 'snow', 'dust', 'bokeh', 'stars', 'fireflies'
    const [particleIntensity, setParticleIntensity] = useState(50);
    const [particleSpeed, setParticleSpeed] = useState(50);
    const [messageOverlayEnabled, setMessageOverlayEnabled] = useState(false);
    const [messageOverlayText, setMessageOverlayText] = useState('');
    const [messageOverlayPosition, setMessageOverlayPosition] = useState('center');
    const [messageOverlaySize, setMessageOverlaySize] = useState(72);
    const [messageOverlayColor, setMessageOverlayColor] = useState('#ffffff');
    const [messageOverlayWeight, setMessageOverlayWeight] = useState('800');
    const [messageOverlayUppercase, setMessageOverlayUppercase] = useState(false);
    const [messageOverlayBackdrop, setMessageOverlayBackdrop] = useState(true);

    const [videoViewMode, setVideoViewMode] = useState(() => {
        return localStorage.getItem(VIEW_MODE_KEY) || 'grid';
    });
    const [mediaFolders, setMediaFolders] = useState(DEFAULT_FOLDERS);
    const [activeFolderId, setActiveFolderId] = useState(() => {
        return localStorage.getItem(ACTIVE_FOLDER_KEY) || 'all';
    });
    const [newFolderName, setNewFolderName] = useState('');
    const [isDropActive, setIsDropActive] = useState(false);
    const [isImportingDrop, setIsImportingDrop] = useState(false);
    const seekTrackRef = useRef(null);
    const seekDraggingRef = useRef(false);
    const throttledMediaTimeUpdate = useThrottledCallback((data) => {
        setDuration(data.duration || 0);
        if (!seekDraggingRef.current) setCurrentTime(data.currentTime || 0);
    }, 200);

    // mediaIds are per-app-run, so every restored playlist needs fresh ones before its items
    // can be streamed or thumbnailed. Set the saved list first so the UI paints immediately,
    // then swap in the registered version.
    useEffect(() => deferUntilIdle(() => {
        const savedPlaylist = readLocalStorageArraySafe(MEDIA_PLAYLIST_KEY);
        const merged = mergeFolderLists(
            readLocalStorageArraySafe(MEDIA_FOLDERS_KEY, DEFAULT_FOLDERS),
            readLocalStorageArraySafe(PHOTO_FOLDERS_KEY, DEFAULT_FOLDERS),
            readLocalStorageArraySafe(PHOTO_PLAYLIST_KEY)
        );
        const savedPhotos = merged.photos;
        setPlaylist(savedPlaylist);
        setPhotoPlaylist(savedPhotos);
        setMediaFolders(merged.folders);
        setScheduledPlays(readLocalStorageArraySafe(SCHEDULED_PLAYS_KEY));

        ensureMediaIds(savedPlaylist)
            .then(next => { if (next !== savedPlaylist) setPlaylist(next); })
            .catch(err => console.error('Could not re-register saved media:', err));
        ensureMediaIds(savedPhotos)
            .then(next => { if (next !== savedPhotos) setPhotoPlaylist(next); })
            .catch(err => console.error('Could not re-register saved photos:', err));
    }), []);
    useDebouncedLocalStorageEffect(SCHEDULED_PLAYS_KEY, scheduledPlays);

    useDebouncedLocalStorageEffect(MEDIA_PLAYLIST_KEY, playlist);
    useDebouncedLocalStorageEffect(PHOTO_PLAYLIST_KEY, photoPlaylist);

    // Emit Particle Updates
    useEffect(() => {
        if (!socket) return;
        socket.emit('particles_update', {
            enabled: particlesEnabled,
            type: particleType,
            intensity: particleIntensity,
            speed: particleSpeed
        });
    }, [particlesEnabled, particleType, particleIntensity, particleSpeed, socket]);

    useEffect(() => {
        if (!socket) return;
        socket.emit('media_message_overlay_update', {
            enabled: messageOverlayEnabled,
            text: messageOverlayText,
            position: messageOverlayPosition,
            size: messageOverlaySize,
            color: messageOverlayColor,
            weight: messageOverlayWeight,
            uppercase: messageOverlayUppercase,
            backdrop: messageOverlayBackdrop
        });
    }, [messageOverlayEnabled, messageOverlayText, messageOverlayPosition, messageOverlaySize, messageOverlayColor, messageOverlayWeight, messageOverlayUppercase, messageOverlayBackdrop, socket]);

    useEffect(() => {
        localStorage.setItem(VIEW_MODE_KEY, videoViewMode);
    }, [videoViewMode]);

    useDebouncedLocalStorageEffect(MEDIA_FOLDERS_KEY, mediaFolders);
    // Photos share the video folders now; keep the old key in step so nothing re-splits them.
    useDebouncedLocalStorageEffect(PHOTO_FOLDERS_KEY, mediaFolders);

    useEffect(() => {
        localStorage.setItem(ACTIVE_FOLDER_KEY, activeFolderId);
    }, [activeFolderId]);

    const activeFolderExists = activeFolderId === 'all' || mediaFolders.some(folder => folder.id === activeFolderId);
    useEffect(() => {
        if (!activeFolderExists) setActiveFolderId('all');
    }, [activeFolderExists]);

    // Socket events for progress
    useEffect(() => {
        if (!socket) return;

        const handleTimeUpdate = (data) => {
            throttledMediaTimeUpdate(data);
        };

        const handleMediaStop = () => {
            seekDraggingRef.current = false;
            setIsPlaying(false);
            setCurrentTime(0);
            setDuration(0);
            setMediaData(null);
        };

        const handlePhotoStop = () => {
            setIsPhotoLive(false);
            setCurrentPhotoIdx(-1);
        };

        const handleMediaPlay = (data) => {
            seekDraggingRef.current = false;
            setIsPlaying(true);
            setMediaData(data);
            setCurrentTime(0);
            setDuration(data?.duration || 0);
        };

        const handleTogglePlay = (state) => setIsPlaying(state);
        const handleMuteState = (state) => setIsMuted(state);
        const handleLoopState = (state) => setLoop(state);
        const handleAutoNextState = (state) => setAutoNext(state);
        socket.on('media_time_update', handleTimeUpdate);
        socket.on('media_stop', handleMediaStop);
        socket.on('photo_stop', handlePhotoStop);
        socket.on('media_play', handleMediaPlay);
        socket.on('media_toggle_play', handleTogglePlay);
        socket.on('media_set_muted', handleMuteState);
        socket.on('media_set_loop', handleLoopState);
        socket.on('media_set_auto_next', handleAutoNextState);
        // Reads the latest handler through a ref instead of bouncing the event through a
        // synthetic DOM CustomEvent to dodge a stale closure. The old indirection also made the
        // listener effect re-subscribe on every playlist change (every drag-reorder, every
        // thumbnail hydration).
        const handleMediaNext = () => playNextRef.current?.();
        socket.on('media_next', handleMediaNext);

        socket.emit('request_media_state');

        return () => {
            socket.off('media_time_update', handleTimeUpdate);
            socket.off('media_stop', handleMediaStop);
            // photo_stop was registered but never removed, so it accumulated a duplicate
            // handler on every remount (and immediately under StrictMode in dev).
            socket.off('photo_stop', handlePhotoStop);
            socket.off('media_play', handleMediaPlay);
            socket.off('media_toggle_play', handleTogglePlay);
            socket.off('media_set_muted', handleMuteState);
            socket.off('media_set_loop', handleLoopState);
            socket.off('media_set_auto_next', handleAutoNextState);
            socket.off('media_next', handleMediaNext);
        };

    }, [socket, throttledMediaTimeUpdate]);

    useEffect(() => {
        const clearTimelineDrag = () => {
            seekDraggingRef.current = false;
        };

        window.addEventListener('pointerup', clearTimelineDrag);
        window.addEventListener('blur', clearTimelineDrag);
        return () => {
            window.removeEventListener('pointerup', clearTimelineDrag);
            window.removeEventListener('blur', clearTimelineDrag);
        };
    }, []);

    // Kept current so the media_next socket handler above always calls the latest closure
    // without having to re-subscribe when the playlist changes.
    const playNextRef = useRef(null);

    const handlePlayNext = () => {
        if (playlist.length === 0) return;
        
        const currentIndex = playlist.findIndex(item => isSameMediaItem(item, mediaData));
        const nextIndex = (currentIndex + 1) % playlist.length;
        playPlaylistItem(playlist[nextIndex]);
    };

    playNextRef.current = handlePlayNext;

    const formatMediaTime = (seconds) => {
        if (!seconds || isNaN(seconds)) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    const getItemTitle = (item) => item?.name || (item?.type === 'youtube' ? `YouTube: ${item.id}` : item?.type === 'webpage' ? item.path : 'Local File');

    const isSameMediaItem = (item, other) => {
        if (!item || !other || item.type !== other.type) return false;
        if (item.type === 'youtube') return item.id === other.id;
        return item.path === other.path;
    };

    const currentPlaylistIndex = playlist.findIndex(item => isSameMediaItem(item, mediaData));
    const currentPlaylistItem = currentPlaylistIndex >= 0 ? playlist[currentPlaylistIndex] : mediaData;
    const effectiveDuration = duration || currentPlaylistItem?.duration || mediaData?.duration || 0;
    const createVideoThumbnail = (video) => {
        const canvas = document.createElement('canvas');
        const sourceWidth = video.videoWidth || 320;
        const sourceHeight = video.videoHeight || 180;
        canvas.width = 320;
        canvas.height = Math.max(1, Math.round((sourceHeight / sourceWidth) * canvas.width));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.72);
    };

    const hydrateLocalVideoItem = (item) => new Promise((resolve) => {
        const video = document.createElement('video');
        let settled = false;

        const finish = (patch = {}) => {
            if (settled) return;
            settled = true;
            video.removeAttribute('src');
            video.load();
            resolve({ ...item, ...patch });
        };

        video.preload = 'metadata';
        video.muted = true;
        video.crossOrigin = 'anonymous';
        if (!item.mediaId) return finish();
        video.src = authUrl('/stream-video', { mediaId: item.mediaId });
        video.onloadedmetadata = () => {
            const detectedDuration = Number.isFinite(video.duration) ? video.duration : item.duration;
            const captureAt = Math.min(Math.max((detectedDuration || 1) * 0.1, 0.15), 2);
            video.currentTime = captureAt;
            video.onseeked = () => {
                try {
                    finish({ duration: detectedDuration, thumbnail: createVideoThumbnail(video) });
                } catch {
                    finish({ duration: detectedDuration });
                }
            };
        };
        video.onerror = () => finish();
        setTimeout(() => finish(), 5000);
    });

    const createLocalVideoItem = async (filePath, folderId = getFolderIdForNewItem(activeFolderId)) => {
        const registered = await registerLocalMedia(filePath, 'local');
        const item = {
            type: 'local',
            path: registered?.path || filePath,
            mediaId: registered?.mediaId,
            name: registered?.name || getFileName(filePath),
            folderId
        };
        return hydrateLocalVideoItem(item);
    };

    const updatePlaylistItem = (index, patch) => {
        setPlaylist(prev => prev.map((item, idx) => idx === index ? { ...item, ...patch } : item));
    };

    const addMediaFolder = () => {
        const name = newFolderName.trim();
        if (!name) return;
        const id = `folder-${Date.now()}`;
        setMediaFolders(prev => [...prev, { id, name }]);
        setActiveFolderId(id);
        setNewFolderName('');
    };

    const updatePhotoItem = (index, patch) => {
        setPhotoPlaylist(prev => prev.map((item, idx) => idx === index ? { ...item, ...patch } : item));
    };

    const handleAddYoutubePlaylist = async () => {
        const url = youtubePlaylistUrl.trim();
        if (!url) { alert("Please enter a YouTube Playlist URL."); return; }
        if (!url.includes('list=')) { alert("Invalid Playlist URL. Must contain 'list='"); return; }

        // Optionally cap to the newest N videos (blank / invalid = fetch all).
        const limit = parseInt(playlistLimit, 10);
        const params = Number.isFinite(limit) && limit > 0 ? { url, max: String(limit) } : { url };

        setIsFetchingPlaylist(true);
        try {
            const response = await fetch(authUrl('/fetch-youtube-playlist', params));
            if (response.ok) {
                const items = await response.json();
                if (items && items.length > 0) {
                    // Open the picker with everything selected by default.
                    setPlaylistPickerItems(items);
                    setSelectedVideoIds(new Set(items.map(item => item.id)));
                    setYoutubePlaylistUrl('');
                } else {
                    alert("No videos found in this playlist.");
                }
            } else {
                alert("Failed to fetch playlist items.");
            }
        } catch (e) {
            console.error(e);
            alert("Error fetching playlist.");
        }
        setIsFetchingPlaylist(false);
    };

    const toggleVideoSelected = (id) => {
        setSelectedVideoIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const allPickerSelected = playlistPickerItems
        ? selectedVideoIds.size === playlistPickerItems.length
        : false;

    const toggleSelectAllPicker = () => {
        if (!playlistPickerItems) return;
        setSelectedVideoIds(allPickerSelected ? new Set() : new Set(playlistPickerItems.map(i => i.id)));
    };

    const closePlaylistPicker = () => {
        setPlaylistPickerItems(null);
        setSelectedVideoIds(new Set());
    };

    const confirmImportPlaylist = () => {
        if (!playlistPickerItems) return;
        const folderId = getFolderIdForNewItem(activeFolderId);
        const selected = playlistPickerItems.filter(item => selectedVideoIds.has(item.id));
        if (selected.length === 0) return;
        setPlaylist(prev => [...selected.map(item => ({ ...item, folderId })), ...prev]);
        closePlaylistPicker();
    };

    const toggleMute = () => {
        const newState = !isMuted;
        setIsMuted(newState);
        socket?.emit('media_set_muted', newState);
    };

    const toggleLoop = () => {
        const newState = !loop;
        setLoop(newState);
        socket?.emit('media_set_loop', newState);
    };

    const toggleAutoNext = () => {
        const newState = !autoNext;
        setAutoNext(newState);
        socket?.emit('media_set_auto_next', newState);
    };

    const handleAddYoutube = async () => {
        const ytUrl = youtubeUrl.trim();
        if (!ytUrl) { alert("Please enter a YouTube URL."); return; }
        
        let videoId = '';
        try {
            const url = new URL(ytUrl);
            if (url.hostname.includes('youtu.be')) videoId = url.pathname.slice(1);
            else videoId = url.searchParams.get('v');
        } catch (e) {}

        if (videoId) {
            setIsFetchingYt(true);
            let videoTitle = '';
            try {
                const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.title) videoTitle = data.title;
                }
            } catch(e) {
                console.error("Failed to fetch YT title", e);
            }
            
            setPlaylist(prev => [{ type: 'youtube', id: videoId, name: videoTitle || `YouTube: ${videoId}`, folderId: getFolderIdForNewItem(activeFolderId) }, ...prev]);
            setYoutubeUrl('');
            setIsFetchingYt(false);
        } else {
            alert("Invalid YouTube URL");
        }
    };

    const handleAddWebpage = () => {
        let url = webpageUrl.trim();
        if (!url) { alert("Please enter a webpage URL."); return; }
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        try {
            new URL(url); // validate
        } catch (e) {
            alert("Invalid URL.");
            return;
        }
        const hostname = new URL(url).hostname;
        setPlaylist(prev => [{ type: 'webpage', path: url, name: hostname, folderId: getFolderIdForNewItem(activeFolderId) }, ...prev]);
        setWebpageUrl('');
    };

    const removePlaylistItem = (index, e) => {
        e.stopPropagation();
        setPlaylist(prev => prev.filter((_, i) => i !== index));
    };

    const playPlaylistItem = (item) => {
        if (!socket) return;
        const timestamp = Date.now();
        const payload = { ...item, ts: timestamp };
        if (item.type === 'youtube') {
            socket.emit('play_media', payload);
        } else if (item.type === 'local') {
            socket.emit('play_media', payload);
        } else if (item.type === 'webpage') {
            socket.emit('play_media', payload);
        }
        setMediaData(payload);
        setDuration(item.duration || 0);
        setCurrentTime(0);
        setIsPlaying(true);
    };

    // --- Scheduled Plays: fire a library item at a clock time (once/daily) ---
    // The interval reads the latest schedules + play fn via a ref to dodge stale
    // closures (same concern as the media_next handler above).
    const scheduleRuntimeRef = useRef({ scheduledPlays, playPlaylistItem });
    scheduleRuntimeRef.current = { scheduledPlays, playPlaylistItem };

    useEffect(() => {
        const interval = setInterval(() => {
            const { scheduledPlays: schedules, playPlaylistItem: play } = scheduleRuntimeRef.current;
            if (!schedules || schedules.length === 0) return;
            const now = new Date();
            setScheduleNow(now); // drives the live countdown display
            const fireIds = new Set();
            for (const s of schedules) {
                if (scheduleTick(s, now).shouldFire) fireIds.add(s.id);
            }
            if (fireIds.size === 0) return;
            const todayKey = localDateKey(now);
            for (const s of schedules) {
                if (fireIds.has(s.id) && s.item) play(s.item);
            }
            setScheduledPlays(prev => prev.map(s => {
                if (!fireIds.has(s.id)) return s;
                return s.mode === 'once'
                    ? { ...s, enabled: false, lastFiredDate: todayKey }
                    : { ...s, lastFiredDate: todayKey };
            }));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    const toggleNewScheduleDay = (day) => setNewScheduleDays(prev => (
        prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    ));

    const addSchedule = () => {
        if (newScheduleIdx === '' || !newScheduleTime) return;
        if (newScheduleMode === 'weekly' && newScheduleDays.length === 0) return;
        const item = playlist[Number(newScheduleIdx)];
        if (!item) return;
        setScheduledPlays(prev => [...prev, {
            id: `sched-${Date.now()}`,
            item,
            time: newScheduleTime,
            mode: newScheduleMode,
            days: newScheduleMode === 'weekly' ? [...newScheduleDays].sort((a, b) => a - b) : undefined,
            enabled: true,
            lastFiredDate: null,
        }]);
        setNewScheduleIdx('');
        setNewScheduleTime('');
        setNewScheduleMode('once');
        setNewScheduleDays([]);
    };

    const removeSchedule = (id) => setScheduledPlays(prev => prev.filter(s => s.id !== id));

    const toggleSchedule = (id) => setScheduledPlays(prev => prev.map(s => {
        if (s.id !== id) return s;
        const enabling = !s.enabled;
        const patch = { enabled: enabling };
        // Re-enabling a fired one-time schedule makes it eligible again.
        if (enabling && s.mode === 'once') patch.lastFiredDate = null;
        return { ...s, ...patch };
    }));

    const handleMediaDrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDropActive(false);

        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;

        if (!window.broadcastAPI?.getPathForFile) {
            alert('Drag/drop import requires running the Electron app.');
            return;
        }

        setIsImportingDrop(true);
        const folderId = getFolderIdForNewItem(activeFolderId);
        const videoItems = [];
        const photoItems = [];
        const skippedFiles = [];

        for (const file of files) {
            const filePath = window.broadcastAPI.getPathForFile(file);
            if (!filePath) {
                skippedFiles.push(file.name);
            } else if (isVideoPath(filePath)) {
                videoItems.push(await createLocalVideoItem(filePath, folderId));
            } else if (isImagePath(filePath)) {
                const registered = await registerLocalMedia(filePath, 'photo');
                photoItems.push({ type: 'photo', path: registered.path, mediaId: registered.mediaId, name: registered.name || getFileName(filePath), folderId: getFolderIdForNewItem(activeFolderId) });
            } else {
                skippedFiles.push(file.name || getFileName(filePath));
            }
        }

        if (videoItems.length > 0) setPlaylist(prev => [...videoItems, ...prev]);
        if (photoItems.length > 0) setPhotoPlaylist(prev => [...photoItems, ...prev]);
        if (skippedFiles.length > 0) {
            alert(`Skipped ${skippedFiles.length} unsupported file${skippedFiles.length === 1 ? '' : 's'}.`);
        }
        setIsImportingDrop(false);
    };

    // --- PHOTO LIBRARY HANDLERS ---
    const handleAddCanva = async () => {
        if (!canvaUrl) return;
        let url = canvaUrl.trim();

        // Extract URL from iframe tag if pasted
        if (url.includes('<iframe')) {
            const srcMatch = url.match(/src="([^"]+)"/);
            if (srcMatch) url = srcMatch[1];
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        // Same handling as the Slides tab: expand a canva.link short link, then fold
        // whichever share form was pasted into the one embeddable viewer URL. This
        // used to be a private copy of the old normalizer here, which meant a short
        // link saved into this library was silently turned into a dead URL.
        const resolved = await resolveDeckUrl(url);
        if (resolved.error) {
            alert(resolved.error);
            return;
        }
        url = normalizeCanvaUrl(resolved.url);

        const newItem = { type: 'canva', path: url, name: canvaName || 'Canva Presentation', folderId: getFolderIdForNewItem(activeFolderId) };
        const newPlaylist = [...photoPlaylist, newItem];
        setPhotoPlaylist(newPlaylist);
        setCanvaUrl('');
        setCanvaName('');
    };

    const removePhotoItem = (index, e) => {
        if (e) e.stopPropagation();
        const newPlaylist = photoPlaylist.filter((_, i) => i !== index);
        setPhotoPlaylist(newPlaylist);
        if (currentPhotoIdx === index) stopPhotoOutput();
    };

    const stopPhotoOutput = () => {
        setIsPhotoLive(false);
        setCurrentPhotoIdx(-1);
        socket?.emit('photo_stop');
    };

    const playPhotoAtIndex = (index) => {
        if (index < 0 || index >= photoPlaylist.length) return;
        setCurrentPhotoIdx(index);
        let item = { ...photoPlaylist[index] };
        
        // Self-healing for links saved before normalization existed. A plain share URL
        // answers with X-Frame-Options: deny, so without the ?embed form the output
        // window shows nothing at all.
        if (item.type === 'canva' && isCanvaUrl(item.path) && !item.path.includes('?embed')) {
            item.path = normalizeCanvaUrl(item.path);
        }

        socket?.emit('photo_play', { ...item, ts: Date.now() });
    };

    // Photo Automation Timer
    useEffect(() => {
        let timer = null;
        if (isPhotoLive && photoAutoNext && photoPlaylist.length > 1) {
            timer = setTimeout(() => {
                let nextIdx = currentPhotoIdx + 1;
                if (nextIdx >= photoPlaylist.length) {
                    if (photoLoop) nextIdx = 0;
                    else {
                        stopPhotoOutput();
                        return;
                    }
                }
                playPhotoAtIndex(nextIdx);
            }, photoInterval * 1000);
        }
        return () => clearTimeout(timer);
    }, [isPhotoLive, photoAutoNext, photoLoop, photoInterval, currentPhotoIdx, photoPlaylist]);

    const handleStopClear = () => {
        socket?.emit('stop_media');
        setIsPlaying(false);
        setMediaData(null);
    };

    const clearMessageOverlay = () => {
        setMessageOverlayText('');
        setMessageOverlayEnabled(false);
    };

    const togglePlay = () => {
        const newPlayState = !isPlaying;
        setIsPlaying(newPlayState);
        socket?.emit('media_toggle_play', newPlayState);
    };

    const commitSeekTime = (value) => {
        const val = Number(value);
        if (!Number.isFinite(val) || !effectiveDuration) return;
        const clamped = Math.min(Math.max(0, val), effectiveDuration);
        setCurrentTime(clamped);
        socket?.emit('media_seek', clamped);
    };

    const seekFromClientX = (clientX) => {
        const track = seekTrackRef.current;
        if (!track || !effectiveDuration) return;
        const rect = track.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
        commitSeekTime(ratio * effectiveDuration);
    };

    const handleTimelinePointerDown = (e) => {
        if (!effectiveDuration) return;
        seekDraggingRef.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        seekFromClientX(e.clientX);
    };

    const handleTimelinePointerMove = (e) => {
        if (!seekDraggingRef.current) return;
        seekFromClientX(e.clientX);
    };

    const stopTimelineDrag = (e) => {
        seekDraggingRef.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
    };

    const handleTimelineKeyDown = (e) => {
        if (!effectiveDuration) return;
        const step = e.shiftKey ? 10 : 5;
        let nextTime = currentTime;
        if (e.key === 'ArrowLeft') nextTime -= step;
        else if (e.key === 'ArrowRight') nextTime += step;
        else if (e.key === 'Home') nextTime = 0;
        else if (e.key === 'End') nextTime = effectiveDuration;
        else return;
        e.preventDefault();
        commitSeekTime(nextTime);
    };

    const progressPercent = effectiveDuration ? Math.min(Math.max((currentTime / effectiveDuration) * 100, 0), 100) : 0;

    // ---- Unified, folder-first library (redesign) ----------------------------------------
    // Videos and photos still live in their own arrays (playback, Run of Show and schedules
    // read those), but they are shown as ONE library: one set of folders, one order.
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const [addMode, setAddMode] = useState(null);
    const [moreMenuOpen, setMoreMenuOpen] = useState(false);
    const [showOverlays, setShowOverlays] = useState(false);
    const [showNewFolderInput, setShowNewFolderInput] = useState(false);
    const [librarySearch, setLibrarySearch] = useState('');
    const [libraryOrder, setLibraryOrder] = useState(() => readLocalStorageArraySafe(LIBRARY_ORDER_KEY));
    const [draggedKey, setDraggedKey] = useState(null);
    const [dropFolderId, setDropFolderId] = useState(null);
    const [draggedFolderId, setDraggedFolderId] = useState(null);
    const [renamingFolderId, setRenamingFolderId] = useState(null);
    const [renameDraft, setRenameDraft] = useState('');
    const [lastLiveKind, setLastLiveKind] = useState(null);
    const addMenuRef = useRef(null);
    const moreMenuRef = useRef(null);
    // The live controls render into a slot under the Live Preview (see App.jsx), so they
    // sit in one fixed place next to the picture they control.
    const [dockEl, setDockEl] = useState(null);
    useEffect(() => { setDockEl(document.getElementById('bc-media-dock')); }, []);

    useDebouncedLocalStorageEffect(LIBRARY_ORDER_KEY, libraryOrder);

    useEffect(() => {
        if (!addMenuOpen && !moreMenuOpen) return undefined;
        const onPointerDown = (e) => {
            if (addMenuRef.current && !addMenuRef.current.contains(e.target)) setAddMenuOpen(false);
            if (moreMenuRef.current && !moreMenuRef.current.contains(e.target)) setMoreMenuOpen(false);
        };
        const onKeyDown = (e) => { if (e.key === 'Escape') { setAddMenuOpen(false); setMoreMenuOpen(false); } };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [addMenuOpen, moreMenuOpen]);

    // Every item in one list, in the operator's order. Items not in the saved order yet
    // (just added) go to the top, newest first.
    const orderRank = new Map(libraryOrder.map((key, i) => [key, i]));
    const libraryEntries = [
        ...playlist.map((item, index) => ({ kind: 'video', item, index, key: videoLibraryKey(item) })),
        ...photoPlaylist.map((item, index) => ({ kind: 'photo', item, index, key: photoLibraryKey(item) }))
    ].sort((a, b) => (orderRank.has(a.key) ? orderRank.get(a.key) : -1) - (orderRank.has(b.key) ? orderRank.get(b.key) : -1));

    const searchQuery = librarySearch.trim().toLowerCase();
    const entryTitle = (entry) => entry.kind === 'video' ? getItemTitle(entry.item) : (entry.item.name || 'Photo');
    const shownEntries = libraryEntries.filter(entry =>
        (activeFolderId === 'all' || (entry.item.folderId || DEFAULT_FOLDER_ID) === activeFolderId)
        && (!searchQuery || entryTitle(entry).toLowerCase().includes(searchQuery)));
    const folderCount = (folderId) => libraryEntries.filter(entry => (entry.item.folderId || DEFAULT_FOLDER_ID) === folderId).length;

    // Reordering the combined list also re-sorts the two underlying arrays, so "next" and
    // auto-advance follow the order the operator sees.
    const applyLibraryOrder = (keys) => {
        setLibraryOrder(keys);
        const rank = new Map(keys.map((key, i) => [key, i]));
        const byRank = (keyFn) => (a, b) => (rank.get(keyFn(a)) ?? -1) - (rank.get(keyFn(b)) ?? -1);
        setPlaylist(prev => [...prev].sort(byRank(videoLibraryKey)));
        const livePhotoKey = currentPhotoIdx >= 0 && photoPlaylist[currentPhotoIdx] ? photoLibraryKey(photoPlaylist[currentPhotoIdx]) : null;
        const sortedPhotos = [...photoPlaylist].sort(byRank(photoLibraryKey));
        setPhotoPlaylist(sortedPhotos);
        if (livePhotoKey) setCurrentPhotoIdx(sortedPhotos.findIndex(p => photoLibraryKey(p) === livePhotoKey));
    };

    const onEntryDragStart = (e, key) => {
        setDraggedKey(key);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', key);
    };
    const onEntryDragOver = (e, targetKey) => {
        if (!draggedKey) return;
        e.preventDefault();
        if (draggedKey === targetKey) return;
        const keys = libraryEntries.map(entry => entry.key);
        const from = keys.indexOf(draggedKey);
        const to = keys.indexOf(targetKey);
        if (from < 0 || to < 0) return;
        keys.splice(from, 1);
        keys.splice(to, 0, draggedKey);
        applyLibraryOrder(keys);
    };
    const onEntryDragEnd = () => { setDraggedKey(null); setDropFolderId(null); };

    const moveEntryToFolder = (key, folderId) => {
        const entry = libraryEntries.find(x => x.key === key);
        if (!entry) return;
        if (entry.kind === 'video') updatePlaylistItem(entry.index, { folderId });
        else updatePhotoItem(entry.index, { folderId });
    };

    const deleteFolder = (folder) => {
        if (folder.id === DEFAULT_FOLDER_ID) return;
        const count = folderCount(folder.id);
        const what = count === 0 ? 'It is empty.' : `Its ${count} item${count === 1 ? '' : 's'} will move to Unsorted — nothing is removed from the library.`;
        if (!window.confirm(`Delete the folder "${folder.name}"? ${what}`)) return;
        const unfile = (item) => item.folderId === folder.id ? { ...item, folderId: DEFAULT_FOLDER_ID } : item;
        setPlaylist(prev => prev.map(unfile));
        setPhotoPlaylist(prev => prev.map(unfile));
        setMediaFolders(prev => prev.filter(f => f.id !== folder.id));
        if (activeFolderId === folder.id) setActiveFolderId('all');
    };

    const clearWholeLibrary = () => {
        const total = playlist.length + photoPlaylist.length;
        if (total === 0) return;
        if (!window.confirm(`Remove all ${total} items from the media library? Your folders stay, and the files on your computer are not touched. This can't be undone.`)) return;
        setPlaylist([]);
        setPhotoPlaylist([]);
        stopPhotoOutput();
    };

    const playEntry = (entry) => {
        if (entry.kind === 'video') {
            setLastLiveKind('video');
            playPlaylistItem(entry.item);
        } else {
            setLastLiveKind('photo');
            setIsPhotoLive(true);
            playPhotoAtIndex(entry.index);
        }
    };

    const handlePlayPrev = () => {
        if (playlist.length === 0) return;
        const currentIndex = playlist.findIndex(item => isSameMediaItem(item, mediaData));
        const prevIndex = currentIndex <= 0 ? playlist.length - 1 : currentIndex - 1;
        playPlaylistItem(playlist[prevIndex]);
    };

    // One step: pick the file and it lands in the library (no separate "Add" click).
    const addVideoFromComputer = async () => {
        if (!window.broadcastAPI) { alert('Native file browsing requires running the Electron app.'); return; }
        try {
            const filePath = await window.broadcastAPI.selectLocalVideo();
            if (!filePath) return;
            const item = await createLocalVideoItem(filePath);
            setPlaylist(prev => [item, ...prev]);
        } catch (err) {
            console.error('Could not add video', err);
            alert('Could not add that video.');
        }
    };

    const addPhotosFromComputer = async () => {
        if (!window.broadcastAPI) { alert('Native photo browsing requires running the Electron app.'); return; }
        try {
            const filePaths = await window.broadcastAPI.selectLocalPhoto();
            if (!filePaths || filePaths.length === 0) return;
            const folderId = getFolderIdForNewItem(activeFolderId);
            const newItems = await Promise.all(filePaths.map(async p => {
                const registered = await registerLocalMedia(p, 'photo');
                return { type: 'photo', path: registered.path, mediaId: registered.mediaId, name: registered.name || p.split(/[/\\]/).pop(), folderId };
            }));
            setPhotoPlaylist(prev => [...prev, ...newItems]);
        } catch (err) {
            console.error('Could not add photos', err);
            alert('Could not add those photos.');
        }
    };

    const chooseAddOption = (mode) => {
        setAddMenuOpen(false);
        if (mode === 'videoFile') addVideoFromComputer();
        else if (mode === 'photoFile') addPhotosFromComputer();
        else setAddMode(mode);
    };

    const commitNewFolder = () => {
        addMediaFolder();
        setShowNewFolderInput(false);
    };

    const renderEntryThumb = (entry) => {
        const { item } = entry;
        if (entry.kind === 'photo') {
            if (item.type === 'photo') return <img src={item.mediaId ? authUrl('/local-image', { mediaId: item.mediaId }) : undefined} alt="" className="h-full w-full object-cover" />;
            return <div className="flex h-full w-full items-center justify-center bg-purple-600/15"><Layout className="h-8 w-8 text-purple-400" /></div>;
        }
        if (item.type === 'youtube') return <img src={`https://img.youtube.com/vi/${item.id}/mqdefault.jpg`} alt="" className="h-full w-full object-cover" />;
        if (item.type === 'webpage') return <div className="flex h-full w-full items-center justify-center bg-cyan-600/15"><Globe className="h-8 w-8 text-cyan-500" /></div>;
        if (item.thumbnail) return <img src={item.thumbnail} alt="" className="h-full w-full object-cover" />;
        return <div className="flex h-full w-full items-center justify-center bg-indigo-600/15"><Film className="h-8 w-8 text-indigo-400" /></div>;
    };
    const entryTypeLabel = (entry) => entry.kind === 'photo'
        ? (entry.item.type === 'canva' ? 'Canva' : 'Photo')
        : ({ local: 'Video', youtube: 'YouTube', webpage: 'Web page' }[entry.item.type] || 'Video');

    const livePhoto = isPhotoLive && currentPhotoIdx >= 0 ? photoPlaylist[currentPhotoIdx] : null;
    // Whatever is on air right now — the most recently started one if both are up.
    const liveKind = (lastLiveKind === 'photo' && livePhoto) ? 'photo' : mediaData ? 'video' : livePhoto ? 'photo' : null;
    const remainingTime = effectiveDuration ? Math.max(0, effectiveDuration - currentTime) : 0;
    const viewMode = videoViewMode;
    const setViewMode = setVideoViewMode;
    const roundButtonClass = 'flex h-11 w-11 flex-none items-center justify-center rounded-full border border-slate-300 text-slate-700 transition hover:border-indigo-500 hover:text-indigo-500 active:scale-95 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200';
    const addMenuItemClass = 'flex w-full flex-col items-start rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-slate-800 transition hover:bg-indigo-600/10 dark:text-slate-100';
    const smallToggle = (active) => `h-9 whitespace-nowrap rounded-lg border px-1 text-[11px] font-bold uppercase tracking-normal transition ${active ? 'border-indigo-500 bg-indigo-600/15 text-indigo-600 dark:text-indigo-300' : 'border-slate-300 text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300'}`;
    const folderButtonClass = (active, isDrop) => `group flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px] transition ${isDrop ? 'bg-indigo-600 text-white ring-2 ring-indigo-400' : active ? 'bg-indigo-600/15 font-semibold text-indigo-700 dark:text-indigo-200' : 'text-slate-700 hover:bg-slate-500/10 dark:text-slate-300'}`;
    // A folder row is a drop target for two different drags: a media tile (move the item
    // into this folder) or another folder (reorder the folder list).
    const folderDropProps = (folderId) => ({
        onDragOver: (e) => {
            if (draggedKey) { e.preventDefault(); setDropFolderId(folderId); return; }
            if (draggedFolderId) {
                e.preventDefault();
                if (draggedFolderId === folderId) return;
                setMediaFolders(prev => {
                    const from = prev.findIndex(f => f.id === draggedFolderId);
                    const to = prev.findIndex(f => f.id === folderId);
                    if (from < 0 || to < 0) return prev;
                    const next = [...prev];
                    const [moved] = next.splice(from, 1);
                    next.splice(to, 0, moved);
                    return next;
                });
            }
        },
        onDragLeave: () => setDropFolderId(current => current === folderId ? null : current),
        onDrop: (e) => {
            if (draggedFolderId) { e.preventDefault(); setDraggedFolderId(null); return; }
            if (!draggedKey) return;
            e.preventDefault();
            moveEntryToFolder(draggedKey, folderId);
            setDraggedKey(null);
            setDropFolderId(null);
        }
    });

    const startRenameFolder = (folder) => {
        setRenamingFolderId(folder.id);
        setRenameDraft(folder.name);
    };
    const commitRenameFolder = () => {
        const name = renameDraft.trim();
        if (name && renamingFolderId) {
            setMediaFolders(prev => prev.map(f => f.id === renamingFolderId ? { ...f, name } : f));
        }
        setRenamingFolderId(null);
    };

    return (
        <div className="@container flex flex-col gap-4">
            {/* ===== Header: search · view · overlays · ⋯ · Add ===== */}
            <div className="flex items-center gap-2 @xl:gap-3">
                <label className="control-field flex h-9 min-w-0 flex-1 items-center gap-2 px-3" style={{ maxWidth: '18rem' }}>
                    <Search className="h-4 w-4 flex-none text-slate-400" />
                    <input
                        type="text"
                        value={librarySearch}
                        onChange={e => setLibrarySearch(e.target.value)}
                        placeholder="Search all media"
                        aria-label="Search all media"
                        className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                    />
                    {librarySearch && (
                        <button onClick={() => setLibrarySearch('')} aria-label="Clear search" className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
                    )}
                </label>
                <div className="ml-auto flex flex-none items-center gap-2">
                    <button onClick={() => setShowOverlays(open => !open)} aria-pressed={showOverlays} title="Overlays (message, particles)" aria-label="Overlays"
                        className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] font-medium transition ${showOverlays ? 'border-indigo-500 bg-indigo-600/15 text-indigo-700 dark:text-indigo-200' : 'border-slate-300 text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300'}`}>
                        <Type className="h-4 w-4" />
                        <span className="hidden @xl:inline">Overlays</span>
                        {(messageOverlayEnabled || particlesEnabled) && <span className="h-2 w-2 rounded-full bg-emerald-500" aria-label="An overlay is on" />}
                    </button>
                    <div className="surface-muted flex items-center rounded-lg p-1">
                        <button onClick={() => setViewMode('grid')} aria-label="Grid view" title="Grid view" className={`rounded-md p-1.5 transition ${viewMode === 'grid' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}><Grid className="h-4 w-4" /></button>
                        <button onClick={() => setViewMode('list')} aria-label="List view" title="List view" className={`rounded-md p-1.5 transition ${viewMode === 'list' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}><List className="h-4 w-4" /></button>
                    </div>
                    <div className="relative" ref={moreMenuRef}>
                        <button onClick={() => setMoreMenuOpen(open => !open)} aria-haspopup="menu" aria-expanded={moreMenuOpen} aria-label="Library options" title="Library options"
                            className="surface-muted flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:text-slate-800 dark:hover:text-slate-200">
                            <MoreHorizontal className="h-5 w-5" />
                        </button>
                        {moreMenuOpen && (
                            <div role="menu" className="surface-raised absolute right-0 top-12 z-30 w-72 rounded-xl p-1.5 shadow-2xl">
                                <button role="menuitem" onClick={() => { setMoreMenuOpen(false); setAddMode('schedule'); }} className={addMenuItemClass}>
                                    Scheduled videos…
                                    <span className="text-xs font-normal text-slate-500 dark:text-slate-400">Auto-play a video at a set time</span>
                                </button>
                                <div className="section-rule my-1 h-px" />
                                <button role="menuitem"
                                    onClick={() => { setMoreMenuOpen(false); clearWholeLibrary(); }}
                                    disabled={playlist.length + photoPlaylist.length === 0}
                                    className="flex w-full flex-col items-start rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-red-600 transition hover:bg-red-600/10 disabled:cursor-not-allowed disabled:opacity-40">
                                    Clear entire library…
                                    <span className="text-xs font-normal text-slate-500 dark:text-slate-400">Removes every item. You'll be asked to confirm.</span>
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="relative" ref={addMenuRef}>
                        <button
                            onClick={() => setAddMenuOpen(open => !open)}
                            aria-haspopup="menu"
                            aria-expanded={addMenuOpen}
                            className="flex h-9 items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-indigo-500 active:scale-95"
                        >
                            <Plus className="h-4 w-4" />
                            Add<span className="-ml-1 hidden @md:inline">&nbsp;media</span>
                            <ChevronDown className="h-4 w-4 opacity-80" />
                        </button>
                        {addMenuOpen && (
                            <div role="menu" className="surface-raised absolute right-0 top-12 z-30 w-72 rounded-xl p-1.5 shadow-2xl">
                                <button role="menuitem" onClick={() => chooseAddOption('videoFile')} className={addMenuItemClass}>
                                    Video from computer
                                    <span className="text-xs font-normal text-slate-500 dark:text-slate-400">Or drag files onto the library</span>
                                </button>
                                <button role="menuitem" onClick={() => chooseAddOption('photoFile')} className={addMenuItemClass}>
                                    Photos / slides from computer
                                    <span className="text-xs font-normal text-slate-500 dark:text-slate-400">Pick one or many</span>
                                </button>
                                <div className="section-rule my-1 h-px" />
                                <button role="menuitem" onClick={() => chooseAddOption('youtube')} className={addMenuItemClass}>YouTube video</button>
                                <button role="menuitem" onClick={() => chooseAddOption('ytPlaylist')} className={addMenuItemClass}>YouTube playlist</button>
                                <button role="menuitem" onClick={() => chooseAddOption('canva')} className={addMenuItemClass}>Canva presentation</button>
                                <button role="menuitem" onClick={() => chooseAddOption('webpage')} className={addMenuItemClass}>Web page</button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ===== Overlays (message + particles), opened from the header ===== */}
            {showOverlays && (
                <div className="surface rounded-xl p-4">
                    <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Overlays on top of media</h3>
                        <button onClick={() => setShowOverlays(false)} className="control-button-muted px-3 py-1.5 text-xs font-bold">Close</button>
                    </div>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* MESSAGE OVERLAY */}
                <div className="surface-muted space-y-3 rounded-lg p-3">
                    <div className="flex items-center justify-between border-b section-rule pb-2">
                        <div className="flex items-center space-x-2">
                            <Type className="w-3.5 h-3.5 text-cyan-500" />
                            <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Message Overlay</h4>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" className="sr-only peer" checked={messageOverlayEnabled} onChange={e => setMessageOverlayEnabled(e.target.checked)} />
                            <div className="w-9 h-5 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-600"></div>
                        </label>
                    </div>

                    <div className={`${messageOverlayEnabled ? 'opacity-100' : 'opacity-50'} space-y-3 transition-all duration-300`}>
                        <textarea
                            value={messageOverlayText}
                            onChange={e => setMessageOverlayText(e.target.value)}
                            rows="2"
                            maxLength={180}
                            placeholder="Type a message to show over media..."
                            className="control-field w-full resize-none px-3 py-2 text-xs focus:ring-cyan-500"
                        />

                        <div className="grid grid-cols-2 gap-3">
                            <label className="space-y-1.5">
                                <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Position</span>
                                <select value={messageOverlayPosition} onChange={e => setMessageOverlayPosition(e.target.value)} className="control-field w-full px-2 py-1.5 text-[10px]">
                                    <option value="top">Top</option>
                                    <option value="center">Center</option>
                                    <option value="bottom">Bottom</option>
                                    <option value="lowerThird">Lower Third</option>
                                </select>
                            </label>
                            <label className="space-y-1.5">
                                <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Weight</span>
                                <select value={messageOverlayWeight} onChange={e => setMessageOverlayWeight(e.target.value)} className="control-field w-full px-2 py-1.5 text-[10px]">
                                    <option value="500">Medium</option>
                                    <option value="700">Bold</option>
                                    <option value="800">Extra Bold</option>
                                    <option value="900">Black</option>
                                </select>
                            </label>
                        </div>

                        <div className="grid grid-cols-[1fr_auto] gap-3">
                            <label className="space-y-1.5">
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Size</span>
                                    <span className="text-[10px] font-mono font-bold text-cyan-500">{messageOverlaySize}px</span>
                                </div>
                                <input type="range" min="28" max="150" value={messageOverlaySize} onChange={e => setMessageOverlaySize(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500" />
                            </label>
                            <label className="space-y-1.5">
                                <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Color</span>
                                <input type="color" value={messageOverlayColor} onChange={e => setMessageOverlayColor(e.target.value)} className="h-8 w-11 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent p-1" />
                            </label>
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                            <button onClick={() => setMessageOverlayUppercase(prev => !prev)} className={`rounded-lg px-2 py-2 text-[9px] font-bold uppercase tracking-wider transition ${messageOverlayUppercase ? 'bg-cyan-600 text-white' : 'control-button-muted text-slate-500'}`}>
                                Upper: {messageOverlayUppercase ? 'On' : 'Off'}
                            </button>
                            <button onClick={() => setMessageOverlayBackdrop(prev => !prev)} className={`rounded-lg px-2 py-2 text-[9px] font-bold uppercase tracking-wider transition ${messageOverlayBackdrop ? 'bg-cyan-600 text-white' : 'control-button-muted text-slate-500'}`}>
                                Backdrop: {messageOverlayBackdrop ? 'On' : 'Off'}
                            </button>
                            <button onClick={clearMessageOverlay} className="rounded-lg border border-red-600/20 bg-red-600/10 px-2 py-2 text-[9px] font-bold uppercase tracking-wider text-red-600 transition hover:bg-red-600 hover:text-white">
                                Clear
                            </button>
                        </div>
                    </div>
                </div>
            {/* PARTICLE OVERLAYS */}
            {showParticleOverlayControls && (
                <div className="surface space-y-4 rounded-lg p-4">
                    <div className="flex items-center justify-between border-b section-rule pb-2">
                        <div className="flex items-center space-x-2">
                            <Monitor className="w-4 h-4 text-indigo-500" />
                            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-[0.2em]">Particle Overlays</h3>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" className="sr-only peer" checked={particlesEnabled} onChange={e => setParticlesEnabled(e.target.checked)} />
                            <div className="w-11 h-6 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                        </label>
                    </div>

                    <div className={`${particlesEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'} space-y-4 transition-all duration-300`}>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Effect Type</label>
                                <select 
                                    value={particleType} 
                                    onChange={e => setParticleType(e.target.value)}
                                    className="control-field w-full px-3 py-2 text-xs"
                                >
                                    <option value="dust">Floating Dust</option>
                                    <option value="snow">Gentle Snow</option>
                                    <option value="rain">Heavy Rain</option>
                                    <option value="bokeh">Cinematic Bokeh</option>
                                    <option value="petals">Floating Petals</option>
                                    <option value="bubbles">Floating Bubbles</option>
                                    <option value="stars">Twinkling Stars</option>
                                    <option value="fireflies">Fireflies (Glow)</option>
                                    <option value="confetti">Party Confetti</option>
                                    <option value="digital">Digital Rain (Matrix)</option>
                                </select>
                            </div>
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">Speed</label>
                                <div className="flex items-center space-x-3">
                                    <input 
                                        type="range" min="1" max="100" value={particleSpeed} 
                                        onChange={e => setParticleSpeed(parseInt(e.target.value))}
                                        className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" 
                                    />
                                    <span className="text-[10px] font-mono font-bold text-indigo-500 w-6">{particleSpeed}</span>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex justify-between items-center">
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Density / Intensity</label>
                                <span className="text-[10px] font-mono font-bold text-indigo-500 bg-indigo-500/10 px-2 py-0.5 rounded">{particleIntensity}%</span>
                            </div>
                            <input 
                                type="range" min="1" max="100" value={particleIntensity} 
                                onChange={e => setParticleIntensity(parseInt(e.target.value))}
                                className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" 
                            />
                        </div>
                    </div>
                </div>
            )}
                        {!showParticleOverlayControls && (
                            <p className="text-xs text-slate-500 dark:text-slate-400">Particle effects can be turned on in Settings.</p>
                        )}
                    </div>
                </div>
            )}

            {/* ===== Add panel (opens from the Add menu) ===== */}
            {addMode && (
                <div className="surface space-y-3 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
                            {addMode === 'youtube' && 'Add a YouTube video'}
                            {addMode === 'ytPlaylist' && 'Add a YouTube playlist'}
                            {addMode === 'webpage' && 'Add a web page'}
                            {addMode === 'canva' && 'Add a Canva presentation'}
                            {addMode === 'schedule' && 'Scheduled videos'}
                        </h3>
                        <button onClick={() => setAddMode(null)} className="control-button-muted px-3 py-1.5 text-xs font-bold">Done</button>
                    </div>

                    {addMode === 'youtube' && (
                        <div className="flex gap-2">
                            <input type="text" value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleAddYoutube(); }} placeholder="Paste a YouTube link" autoFocus
                                className="control-field h-10 flex-1 px-3 text-sm" />
                            <button onClick={handleAddYoutube} disabled={isFetchingYt} className="h-10 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">
                                {isFetchingYt ? 'Adding…' : 'Add'}
                            </button>
                        </div>
                    )}

                    {addMode === 'ytPlaylist' && (
                        <div className="space-y-2">
                            <div className="flex gap-2">
                                <input type="text" value={youtubePlaylistUrl} onChange={e => setYoutubePlaylistUrl(e.target.value)} placeholder="Paste a YouTube playlist link" autoFocus
                                    className="control-field h-10 flex-1 px-3 text-sm" />
                                <input type="number" min="1" value={playlistLimit} onChange={e => setPlaylistLimit(e.target.value)}
                                    title="Newest videos to fetch (leave blank for all)" placeholder="All" aria-label="How many videos"
                                    className="control-field h-10 px-2 text-center text-sm" style={{ width: '5rem' }} />
                                <button onClick={handleAddYoutubePlaylist} disabled={isFetchingPlaylist} className="h-10 flex-none rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">
                                    {isFetchingPlaylist ? 'Loading…' : 'Choose videos'}
                                </button>
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400">Fetches the newest videos first. Leave the count blank to load the whole playlist.</p>
                        </div>
                    )}

                    {addMode === 'webpage' && (
                        <div className="flex gap-2">
                            <input type="text" value={webpageUrl} onChange={e => setWebpageUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleAddWebpage(); }} placeholder="https://example.com" autoFocus
                                className="control-field h-10 flex-1 px-3 text-sm" />
                            <button onClick={handleAddWebpage} className="h-10 flex-none rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-500">Add</button>
                        </div>
                    )}

                    {addMode === 'canva' && (
                        <div className="flex flex-wrap gap-2">
                            <input type="text" value={canvaUrl} onChange={e => setCanvaUrl(e.target.value)} placeholder="Canva share link" autoFocus
                                className="control-field h-10 flex-[2] px-3 text-sm" style={{ minWidth: '15rem' }} />
                            <input type="text" value={canvaName} onChange={e => setCanvaName(e.target.value)} placeholder="Name (optional)"
                                className="control-field h-10 flex-1 px-3 text-sm" style={{ minWidth: '10rem' }} />
                            <button onClick={handleAddCanva} className="h-10 flex-none rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-500">Add</button>
                        </div>
                    )}

                    {addMode === 'schedule' && (
                        <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                        <select value={newScheduleIdx} onChange={e => setNewScheduleIdx(e.target.value)}
                            className="control-field w-full px-3 py-1.5 text-sm">
                            <option value="">Choose a video…</option>
                            {playlist.map((item, i) => (
                                <option key={i} value={i}>{getItemTitle(item)}</option>
                            ))}
                        </select>
                        <input type="time" value={newScheduleTime} onChange={e => setNewScheduleTime(e.target.value)}
                            className="control-field w-full px-3 py-1.5 text-sm" />
                        <div className="flex overflow-hidden rounded-lg border border-slate-500/20">
                            {[['once', 'Once'], ['daily', 'Daily'], ['weekly', 'Days']].map(([mode, label]) => (
                                <button key={mode} onClick={() => setNewScheduleMode(mode)}
                                    className={`flex-1 px-3 py-1.5 text-xs font-bold transition ${newScheduleMode === mode ? 'bg-amber-500 text-white' : 'bg-slate-500/10 text-slate-500'}`}>{label}</button>
                            ))}
                        </div>
                        {newScheduleMode === 'weekly' && (
                            <div className="flex justify-between gap-1">
                                {WEEKDAY_OPTIONS.map(([label, day], i) => {
                                    const active = newScheduleDays.includes(day);
                                    return (
                                        <button key={i} onClick={() => toggleNewScheduleDay(day)}
                                            title={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]}
                                            className={`h-7 flex-1 rounded text-xs font-bold transition ${active ? 'bg-amber-500 text-white' : 'bg-slate-500/10 text-slate-500 hover:bg-slate-500/20'}`}>
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        <button onClick={addSchedule} disabled={newScheduleIdx === '' || !newScheduleTime || (newScheduleMode === 'weekly' && newScheduleDays.length === 0)}
                            className="control-button-muted flex w-full items-center justify-center px-4 py-2 text-sm font-medium active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
                            + Schedule
                        </button>
                    </div>

                    {scheduledPlays.length > 0 ? (
                        <div className="space-y-1.5 border-t section-rule pt-2">
                            {scheduledPlays.map(s => {
                                const { secondsUntil } = scheduleTick(s, scheduleNow);
                                const done = s.mode === 'once' && !!s.lastFiredDate;
                                return (
                                    <div key={s.id} className="flex items-center gap-2 rounded-md bg-slate-500/5 px-2 py-1.5">
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm text-slate-700 dark:text-slate-200">{getItemTitle(s.item)}</div>
                                            <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                                                <span className="font-semibold">{formatClock12(s.time)}</span>
                                                <span className="rounded bg-slate-500/15 px-1 py-0.5 uppercase tracking-wide">{s.mode === 'daily' ? 'Daily' : s.mode === 'weekly' ? formatDays(s.days) : 'Once'}</span>
                                                <span>{done ? 'Done' : (s.enabled ? formatCountdown(secondsUntil) : 'Off')}</span>
                                            </div>
                                        </div>
                                        <button onClick={() => toggleSchedule(s.id)} title={s.enabled ? 'Disable' : 'Enable'}
                                            className={`flex-none rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition ${s.enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-slate-500/15 text-slate-500'}`}>
                                            {s.enabled ? 'On' : 'Off'}
                                        </button>
                                        <button onClick={() => removeSchedule(s.id)} title="Delete schedule"
                                            className="flex-none rounded p-1 text-slate-400 transition hover:bg-red-600/10 hover:text-red-600">
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-xs text-slate-500 dark:text-slate-400">Auto-play a video at a set time. Fires while the Controller window is open.</p>
                    )}
                        </div>
                    )}
                </div>
            )}

            {/* ===== Folders (left) + library (right) ===== */}
            {/* Narrow: folders become a scrollable row of chips above the library. */}
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 @xl:hidden" role="toolbar" aria-label="Folders">
                <button onClick={() => setActiveFolderId('all')}
                    className={`inline-flex h-9 flex-none items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition ${activeFolderId === 'all' ? 'border-transparent bg-indigo-600 text-white' : 'border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300'}`}>
                    All Media <span className="opacity-70">{libraryEntries.length}</span>
                </button>
                {mediaFolders.map(folder => (
                    <button key={folder.id} onClick={() => setActiveFolderId(folder.id)} {...folderDropProps(folder.id)}
                        className={`inline-flex h-9 flex-none items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition ${dropFolderId === folder.id ? 'border-transparent bg-indigo-600 text-white ring-2 ring-indigo-400' : activeFolderId === folder.id ? 'border-transparent bg-indigo-600 text-white' : 'border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300'}`}>
                        <Folder className="h-3.5 w-3.5" />{folder.name} <span className="opacity-70">{folderCount(folder.id)}</span>
                    </button>
                ))}
                <button onClick={() => setShowNewFolderInput(true)} className="inline-flex h-9 flex-none items-center gap-1 rounded-full border border-dashed border-slate-400 px-3.5 text-sm text-slate-500 dark:border-slate-600">
                    <Plus className="h-3.5 w-3.5" /> Folder
                </button>
            </div>
            {showNewFolderInput && (
                <div className="flex items-center gap-2 @xl:hidden">
                    <input type="text" value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitNewFolder(); if (e.key === 'Escape') setShowNewFolderInput(false); }}
                        placeholder="Folder name" aria-label="New folder name" className="control-field h-9 px-3 text-sm" style={{ maxWidth: '16rem' }} />
                    <button onClick={commitNewFolder} className="h-9 flex-none rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white">Create</button>
                    <button onClick={() => setShowNewFolderInput(false)} className="control-button-muted h-9 flex-none px-3 text-sm">Cancel</button>
                </div>
            )}

            <div className="flex items-start gap-4">
                <nav aria-label="Folders" title="Drag media onto a folder to move it. Drag folders to reorder; double-click to rename." className="surface hidden flex-none space-y-1 rounded-xl p-2 @xl:block" style={{ width: '13.5rem' }}>
                    <button onClick={() => setActiveFolderId('all')} className={folderButtonClass(activeFolderId === 'all', false)}>
                        <ListVideo className="h-4 w-4 flex-none" />
                        <span className="flex-1 truncate">All Media</span>
                        <span className="text-xs opacity-70">{libraryEntries.length}</span>
                    </button>
                    <div className="section-rule mx-2 my-1 h-px" />
                    {mediaFolders.map(folder => (
                        renamingFolderId === folder.id ? (
                            <div key={folder.id} className="p-1">
                                <input
                                    type="text"
                                    value={renameDraft}
                                    onChange={e => setRenameDraft(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') commitRenameFolder(); if (e.key === 'Escape') setRenamingFolderId(null); }}
                                    onBlur={commitRenameFolder}
                                    aria-label={`Rename folder ${folder.name}`}
                                    autoFocus
                                    className="control-field h-9 px-3 text-sm"
                                />
                            </div>
                        ) : (
                        <div
                            key={folder.id}
                            className={`group/folder relative ${draggedFolderId === folder.id ? 'opacity-50' : ''}`}
                            draggable
                            onDragStart={(e) => { setDraggedFolderId(folder.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', folder.id); }}
                            onDragEnd={() => setDraggedFolderId(null)}
                            {...folderDropProps(folder.id)}
                        >
                            <button onClick={() => setActiveFolderId(folder.id)} onDoubleClick={() => startRenameFolder(folder)}
                                title={`${folder.name} — drag to reorder, double-click to rename`}
                                className={`${folderButtonClass(activeFolderId === folder.id, dropFolderId === folder.id)} cursor-grab active:cursor-grabbing`}>
                                <Folder className="h-4 w-4 flex-none" />
                                <span className="flex-1 truncate">{folder.name}</span>
                                <span className="text-xs opacity-70 group-hover/folder:opacity-0">{folderCount(folder.id)}</span>
                            </button>
                            <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition group-hover/folder:opacity-100 focus-within:opacity-100">
                                <button onClick={() => startRenameFolder(folder)} aria-label={`Rename folder ${folder.name}`} title="Rename folder"
                                    className="rounded p-1 text-slate-400 transition hover:bg-slate-500/10 hover:text-indigo-500">
                                    <Pencil className="h-3.5 w-3.5" />
                                </button>
                                {folder.id !== DEFAULT_FOLDER_ID && (
                                    <button onClick={() => deleteFolder(folder)} aria-label={`Delete folder ${folder.name}`} title="Delete folder (items move to Unsorted)"
                                        className="rounded p-1 text-slate-400 transition hover:bg-red-600/10 hover:text-red-600">
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>
                        )
                    ))}
                    {showNewFolderInput ? (
                        <div className="space-y-1.5 p-1">
                            <input
                                type="text"
                                value={newFolderName}
                                onChange={e => setNewFolderName(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') commitNewFolder(); if (e.key === 'Escape') setShowNewFolderInput(false); }}
                                placeholder="Folder name"
                                aria-label="New folder name"
                                autoFocus
                                className="control-field h-9 px-3 text-sm"
                            />
                            <div className="flex gap-1.5">
                                <button onClick={commitNewFolder} className="h-8 flex-1 rounded-lg bg-indigo-600 text-xs font-semibold text-white">Create</button>
                                <button onClick={() => setShowNewFolderInput(false)} className="control-button-muted h-8 flex-1 text-xs font-semibold">Cancel</button>
                            </div>
                        </div>
                    ) : (
                        <button onClick={() => setShowNewFolderInput(true)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-500 transition hover:bg-slate-500/10 hover:text-indigo-500">
                            <Plus className="h-4 w-4" /> New folder
                        </button>
                    )}
                </nav>

                {/* Library (also a drop target for files from your computer) */}
                <div
                    className="relative min-w-0 flex-1"
                    onDragEnter={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setIsDropActive(true); } }}
                    onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setIsDropActive(true); } }}
                    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setIsDropActive(false); }}
                    onDrop={(e) => { if (e.dataTransfer?.files?.length) handleMediaDrop(e); else setIsDropActive(false); }}
                >
                    <div className="mb-3 flex items-baseline justify-between gap-3">
                        <h2 className="truncate text-base font-semibold text-slate-800 dark:text-slate-100">
                            {activeFolderId === 'all' ? 'All Media' : (mediaFolders.find(f => f.id === activeFolderId)?.name || 'Folder')}
                            <span className="ml-2 text-sm font-medium text-slate-500">{shownEntries.length} item{shownEntries.length === 1 ? '' : 's'}</span>
                        </h2>
                        <div className="flex items-center gap-3">
                            {scheduledPlays.some(s => s.enabled) && (
                                <button onClick={() => setAddMode('schedule')} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-amber-500/15 px-3 text-xs font-semibold text-amber-600 dark:text-amber-400">
                                    <Clock className="h-3.5 w-3.5" />
                                    {scheduledPlays.filter(s => s.enabled).length} scheduled
                                </button>
                            )}
                        </div>
                    </div>

                    {(isDropActive || isImportingDrop) && (
                        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-indigo-500 bg-indigo-500/10">
                            <div className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-lg">
                                <Upload className="h-4 w-4" />
                                {isImportingDrop ? 'Adding files…' : 'Drop to add to the library'}
                            </div>
                        </div>
                    )}

                    {shownEntries.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 py-16 text-center dark:border-slate-700">
                            <Film className="h-8 w-8 text-slate-400" />
                            <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                                {searchQuery ? 'Nothing matches your search' : libraryEntries.length === 0 ? 'Your media library is empty' : 'This folder is empty'}
                            </p>
                            {!searchQuery && <p className="text-xs text-slate-500">Drag videos or photos here, or use <strong>Add media</strong>.</p>}
                        </div>
                    ) : (
                        <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3 @2xl:gap-4' : 'flex flex-col gap-2'}>
                            {shownEntries.map((entry, visibleIdx) => {
                                const { item, kind, key } = entry;
                                const isCurrentVideo = kind === 'video' && isSameMediaItem(item, mediaData);
                                const onAir = kind === 'video' ? (isCurrentVideo && isPlaying) : (isPhotoLive && currentPhotoIdx === entry.index);
                                const paused = isCurrentVideo && !isPlaying;
                                const grid = viewMode === 'grid';
                                const title = entryTitle(entry);
                                return (
                                    <div
                                        key={`${key}-${visibleIdx}`}
                                        draggable
                                        onDragStart={(e) => onEntryDragStart(e, key)}
                                        onDragOver={(e) => onEntryDragOver(e, key)}
                                        onDragEnd={onEntryDragEnd}
                                        onClick={() => playEntry(entry)}
                                        className={`media-card group relative cursor-pointer overflow-hidden rounded-xl transition ${onAir ? 'ring-2 ring-red-500' : paused ? 'ring-2 ring-amber-500' : ''} ${draggedKey === key ? 'opacity-50' : ''} ${grid ? 'flex flex-col' : 'flex h-[72px] items-center'}`}
                                    >
                                        <div className={grid ? 'relative aspect-video w-full bg-black' : 'relative h-full flex-none bg-black'} style={grid ? undefined : { width: '8rem' }}>
                                            {renderEntryThumb(entry)}
                                            {onAir ? (
                                                <span className="absolute left-2 top-2 rounded bg-red-600 px-2 py-0.5 text-[11px] font-bold tracking-wider text-white">ON AIR</span>
                                            ) : paused ? (
                                                <span className="absolute left-2 top-2 rounded bg-amber-500 px-2 py-0.5 text-[11px] font-bold tracking-wider text-black">PAUSED</span>
                                            ) : null}
                                            {kind === 'video' && item.duration ? (
                                                <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] text-white">{formatMediaTime(item.duration)}</span>
                                            ) : null}
                                            <button
                                                onClick={(e) => { e.stopPropagation(); if (kind === 'video') removePlaylistItem(entry.index, e); else removePhotoItem(entry.index, e); }}
                                                aria-label={`Remove ${title}`} title="Remove from library"
                                                className="absolute right-2 top-2 rounded bg-black/70 p-1 text-white opacity-0 shadow transition-opacity hover:bg-red-600 group-hover:opacity-100">
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                        <div className="min-w-0 flex-1 px-3 py-2">
                                            <p className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100" title={title}>{title}</p>
                                            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                                                {entryTypeLabel(entry)}
                                                {activeFolderId === 'all' && (item.folderId || DEFAULT_FOLDER_ID) !== DEFAULT_FOLDER_ID && (
                                                    <span className="normal-case tracking-normal"> · {mediaFolders.find(f => f.id === item.folderId)?.name}</span>
                                                )}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* ===== Live controls — docked under the Live Preview (fixed position) ===== */}
            {(() => {
                if (!isActive && !liveKind) return null;
                const pill = liveKind
                    ? <span className={`rounded px-2 py-0.5 text-[10px] font-bold tracking-wider ${liveKind === 'video' && !isPlaying ? 'bg-amber-500 text-black' : 'bg-red-600 text-white'}`}>{liveKind === 'video' && !isPlaying ? 'PAUSED' : 'ON AIR'}</span>
                    : <span className="rounded bg-slate-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-slate-500">NOTHING ON AIR</span>;
                const liveName = liveKind === 'video' ? getItemTitle(mediaData) : liveKind === 'photo' ? livePhoto.name : null;
                const dock = (
                    <section aria-label="Live media controls" className={`surface rounded-lg p-3 ${liveKind ? 'ring-2 ring-red-500/40' : ''}`}>
                        <div className="flex items-center justify-between gap-2">
                            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">Media Controls</h3>
                            {pill}
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm font-semibold text-slate-800 dark:text-slate-100" title={liveName || ''}>
                            {liveName || <span className="font-normal text-slate-500">Click something in Media to put it on air</span>}
                        </p>

                        {liveKind === 'photo' ? (
                            <>
                                <p className="mt-0.5 text-xs text-slate-500">{entryTypeLabel({ kind: 'photo', item: livePhoto })} {currentPhotoIdx + 1} of {photoPlaylist.length}</p>
                                <div className="mt-3 flex items-center justify-center gap-3">
                                    <button onClick={() => playPhotoAtIndex(currentPhotoIdx <= 0 ? photoPlaylist.length - 1 : currentPhotoIdx - 1)} aria-label="Previous photo" title="Previous" className={roundButtonClass}><SkipBack className="h-5 w-5" /></button>
                                    <button onClick={() => playPhotoAtIndex(currentPhotoIdx >= photoPlaylist.length - 1 ? 0 : currentPhotoIdx + 1)} aria-label="Next photo" title="Next"
                                        className="flex h-14 w-14 flex-none items-center justify-center rounded-full bg-slate-900 text-white shadow transition hover:bg-indigo-600 active:scale-95 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-indigo-400"><SkipForward className="h-6 w-6" /></button>
                                </div>
                                <div className="mt-3 grid grid-cols-2 gap-2">
                                    <button onClick={() => setPhotoAutoNext(!photoAutoNext)} aria-pressed={photoAutoNext} className={smallToggle(photoAutoNext)}>Auto-advance</button>
                                    <button onClick={() => setPhotoLoop(!photoLoop)} aria-pressed={photoLoop} className={smallToggle(photoLoop)}><Repeat className="mr-1 inline h-3.5 w-3.5" />Loop</button>
                                </div>
                                {photoAutoNext && (
                                    <label className="mt-3 flex items-center gap-2 text-[11px] font-semibold text-slate-500">
                                        <span className="whitespace-nowrap">Every</span>
                                        <input type="range" min="1" max="60" value={photoInterval} onChange={e => setPhotoInterval(parseInt(e.target.value, 10))} aria-label="Seconds between photos"
                                            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-lg bg-slate-200 accent-indigo-500 dark:bg-slate-700" />
                                        <span className="w-8 text-right font-mono text-indigo-500">{photoInterval}s</span>
                                    </label>
                                )}
                                <button onClick={stopPhotoOutput} className="mt-3 h-10 w-full rounded-lg border border-red-600/40 bg-red-600/10 text-xs font-bold uppercase tracking-wider text-red-600 transition hover:bg-red-600 hover:text-white">Stop &amp; Clear</button>
                            </>
                        ) : (
                            <>
                                <div className="mt-3 flex items-center gap-2">
                                    <span className="w-10 font-mono text-[11px] text-slate-600 dark:text-slate-300">{formatMediaTime(currentTime)}</span>
                                    <div
                                        ref={seekTrackRef}
                                        role="slider"
                                        tabIndex={0}
                                        aria-label="Playback position"
                                        aria-valuemin={0}
                                        aria-valuemax={Math.round(effectiveDuration || 0)}
                                        aria-valuenow={Math.round(currentTime || 0)}
                                        onPointerDown={handleTimelinePointerDown}
                                        onPointerMove={handleTimelinePointerMove}
                                        onPointerUp={stopTimelineDrag}
                                        onPointerCancel={stopTimelineDrag}
                                        onKeyDown={handleTimelineKeyDown}
                                        className={`group relative flex h-5 flex-1 items-center ${effectiveDuration ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'} focus:outline-none`}
                                    >
                                        <div className="absolute left-0 right-0 h-2 overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-700">
                                            <div className={`h-full rounded-lg ${isPlaying ? 'bg-red-500' : 'bg-indigo-500'}`} style={{ width: `${progressPercent}%` }} />
                                        </div>
                                        <div className="absolute top-1/2 -ml-2 -mt-2 h-4 w-4 rounded-full border-2 border-white bg-indigo-500 shadow transition-transform group-hover:scale-110 group-focus:scale-110 dark:border-slate-900" style={{ left: `${progressPercent}%` }} />
                                    </div>
                                    <span className="w-12 text-right font-mono text-[11px] text-slate-600 dark:text-slate-300" title="Time left">-{formatMediaTime(remainingTime)}</span>
                                </div>
                                <div className="mt-3 flex items-center justify-center gap-3">
                                    <button onClick={handlePlayPrev} disabled={playlist.length === 0} aria-label="Previous video" title="Previous video" className={roundButtonClass}><SkipBack className="h-5 w-5" /></button>
                                    <button onClick={togglePlay} disabled={!mediaData} aria-label={isPlaying ? 'Pause' : 'Play'} title={isPlaying ? 'Pause' : 'Play'}
                                        className="flex h-14 w-14 flex-none items-center justify-center rounded-full bg-slate-900 text-white shadow transition hover:bg-indigo-600 active:scale-95 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-indigo-400">
                                        {isPlaying ? <Pause className="h-6 w-6 fill-current" /> : <Play className="ml-0.5 h-6 w-6 fill-current" />}
                                    </button>
                                    <button onClick={handlePlayNext} disabled={playlist.length === 0} aria-label="Next video" title="Next video" className={roundButtonClass}><SkipForward className="h-5 w-5" /></button>
                                </div>
                                <div className="mt-3 grid grid-cols-3 gap-2">
                                    <button onClick={toggleLoop} aria-pressed={loop} className={smallToggle(loop)}><Repeat className="mr-1 inline h-3.5 w-3.5" />Loop</button>
                                    <button onClick={toggleAutoNext} aria-pressed={autoNext} className={smallToggle(autoNext)}>Auto-next</button>
                                    <button onClick={toggleMute} aria-pressed={isMuted} className={`h-9 whitespace-nowrap rounded-lg border px-1 text-[11px] font-bold uppercase tracking-normal transition ${isMuted ? 'border-red-500 bg-red-600/15 text-red-600' : 'border-slate-300 text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300'}`}>
                                        {isMuted ? <VolumeX className="mr-1 inline h-3.5 w-3.5" /> : <Volume2 className="mr-1 inline h-3.5 w-3.5" />}
                                        {isMuted ? 'Muted' : 'Mute'}
                                    </button>
                                </div>
                                <button onClick={handleStopClear} disabled={!mediaData} className="mt-3 h-10 w-full rounded-lg border border-red-600/40 bg-red-600/10 text-xs font-bold uppercase tracking-wider text-red-600 transition hover:bg-red-600 hover:text-white disabled:opacity-40 disabled:hover:bg-red-600/10 disabled:hover:text-red-600">Stop &amp; Clear</button>
                            </>
                        )}
                    </section>
                );
                // Remote browsers have no Live Preview column to dock into, so they keep the
                // controls inline under the library instead.
                return dockEl ? createPortal(dock, dockEl) : <div className="mt-2">{dock}</div>;
            })()}

            {/* YouTube playlist import picker */}
            {playlistPickerItems !== null && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
                    onMouseDown={closePlaylistPicker}
                >
                    <div
                        className="surface-raised flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl shadow-2xl"
                        onMouseDown={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex shrink-0 items-start justify-between gap-3 border-b section-rule p-5">
                            <div>
                                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Import Playlist</h3>
                                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                                    {playlistPickerItems.length} video{playlistPickerItems.length === 1 ? '' : 's'} found — choose which to import
                                </p>
                            </div>
                            <button
                                onClick={closePlaylistPicker}
                                className="rounded-full p-1.5 text-slate-500 transition hover:bg-slate-500/10 hover:text-slate-800 dark:hover:text-slate-100"
                                aria-label="Close"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        {/* Toolbar */}
                        <div className="flex shrink-0 items-center justify-between gap-3 border-b section-rule px-5 py-2.5">
                            <button
                                onClick={toggleSelectAllPicker}
                                className="control-button-muted px-3 py-1 text-xs font-bold"
                            >
                                {allPickerSelected ? 'Deselect all' : 'Select all'}
                            </button>
                            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                {selectedVideoIds.size} of {playlistPickerItems.length} selected
                            </span>
                        </div>

                        {/* Video list */}
                        <div className="min-h-0 flex-1 overflow-y-auto p-2">
                            {playlistPickerItems.map(item => {
                                const checked = selectedVideoIds.has(item.id);
                                return (
                                    <label
                                        key={item.id}
                                        className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-slate-500/10"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggleVideoSelected(item.id)}
                                            className="h-4 w-4 shrink-0 cursor-pointer accent-indigo-500"
                                        />
                                        <img
                                            src={`https://i.ytimg.com/vi/${item.id}/default.jpg`}
                                            alt=""
                                            loading="lazy"
                                            className="h-9 w-16 shrink-0 rounded bg-slate-200 object-cover dark:bg-slate-700"
                                        />
                                        <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                                            {item.name}
                                        </span>
                                    </label>
                                );
                            })}
                        </div>

                        {/* Footer */}
                        <div className="flex shrink-0 items-center justify-end gap-2 border-t section-rule p-4">
                            <button onClick={closePlaylistPicker} className="control-button-muted px-4 py-1.5 text-sm font-bold">
                                Cancel
                            </button>
                            <button
                                onClick={confirmImportPlaylist}
                                disabled={selectedVideoIds.size === 0}
                                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                Import Selected ({selectedVideoIds.size})
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
}
