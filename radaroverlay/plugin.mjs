/**
 * radaroverlay - weather radar charts for AvNav
 *
 * Registers raster layer profiles that can be used in chart definitions
 * (see plugin.json) and therefore as chart overlays:
 *
 *  plugin_rainviewer  worldwide radar composite from RainViewer
 *                     (https://www.rainviewer.com/api.html, personal use,
 *                     max zoom 7, 10 minutes, 2h history, no forecast)
 *  plugin_dwdradar    precipitation radar from Deutscher Wetterdienst
 *                     (DWD GeoServer WMS, Germany and neighbours, 5 minutes,
 *                     nowcast up to 2h from a separate layer)
 *  plugin_knmiradar   precipitation radar from KNMI (Netherlands, 5 minutes)
 *                     via the KNMI Data Platform WMS, CC BY 4.0
 *
 * A button on the navigation page opens a settings dialog. There the radar can be
 * switched between the current image and an animation of the last minutes
 * plus (where the source provides it) a forecast.
 *
 * Every source is an entry in SOURCES - to add another radar provider
 * add an entry there and a chart in plugin.json using profile plugin_<key>.
 */

const RAINVIEWER_CATALOG = "https://api.rainviewer.com/public/weather-maps.json";
//re-read the RainViewer frame list at most this often (ms)
const CATALOG_MAX_AGE = 2 * 60 * 1000;
//reload the WMS layers this often (ms) - new radar images every 5 minutes
const WMS_REFRESH = 5 * 60 * 1000;
//the WMS radar images are on a 5 minute grid and appear with some delay
const WMS_STEP = 5 * 60 * 1000;
const WMS_DELAY = 5 * 60 * 1000;
//returned for tiles we cannot provide - lets AvNav fall back to lower zooms
const INVALID_URL = 'data:image/png;base64,i';
//animation: show the last frame this many ticks longer
const HOLD_TICKS = 2;

const EARTH_HALF = 20037508.342789244; //half circumference in EPSG:3857 meters

const isInvalid = (url) => url === undefined || url === INVALID_URL;
const lonToX = (lon) => lon * EARTH_HALF / 180;
const latToY = (lat) => Math.log(Math.tan((90 + lat) * Math.PI / 360)) * EARTH_HALF / Math.PI;

//------------------- settings ------------------------------------------
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = {
    animate: false,
    past: 30,       //minutes of history in the animation
    forecast: 30,   //minutes of forecast in the animation
    interval: 2,    //seconds per animation step
    knmikey: ""     //optional KNMI Data Platform API key
};
const MINUTES = [0, 15, 30, 60, 90, 120];
const SPEEDS = [0.5, 1, 1.5, 2, 3, 5];
const SETTINGS_PARAMETERS = [
    {name: 'animate', type: 'BOOLEAN', displayName: 'Animation', default: DEFAULT_SETTINGS.animate,
        description: 'Radar als Animation statt nur das aktuelle Bild zeigen'},
    {name: 'past', type: 'SELECT', displayName: 'Vergangenheit (min)', list: MINUTES, default: DEFAULT_SETTINGS.past,
        condition: {animate: true}},
    {name: 'forecast', type: 'SELECT', displayName: 'Vorhersage (min)', list: MINUTES, default: DEFAULT_SETTINGS.forecast,
        condition: {animate: true},
        description: 'Nur der DWD liefert eine Vorhersage (bis 120 min). RainViewer und KNMI zeigen nur die Vergangenheit.'},
    {name: 'interval', type: 'SELECT', displayName: 'Sekunden pro Bild', list: SPEEDS, default: DEFAULT_SETTINGS.interval,
        condition: {animate: true},
        description: 'Tempo der Animation: je größer, desto langsamer'},
    {name: 'knmikey', type: 'STRING', displayName: 'KNMI API-Key', default: DEFAULT_SETTINGS.knmikey,
        description: 'Optionaler Key von developer.dataplatform.knmi.nl - macht radar-knmi schneller und zuverlässiger'}
];

let api; //the AvNav plugin api, set on load
//all radar layers currently shown (their contexts)
const liveLayers = new Set();
let activeLayers = 0; //the settings button is only visible with an active radar layer

const setActive = (diff) => {
    activeLayers = Math.max(0, activeLayers + diff);
    if (api) api.setStoreData(api.getStoreBaseKey() + ".active", activeLayers > 0);
}

const getSettings = () => {
    let stored = {};
    try {
        stored = (api && api.getLocalStorage(SETTINGS_KEY, {})) || {};
    } catch (e) {
    }
    const rt = {...DEFAULT_SETTINGS, ...stored};
    for (let k of ['past', 'forecast']) rt[k] = parseInt(rt[k]) || 0;
    rt.interval = Math.max(0.2, parseFloat(rt.interval) || DEFAULT_SETTINGS.interval);
    return rt;
}

//------------------- request handling ----------------------------------
/**
 * a queue that starts at most one request every minInterval ms
 * requests with priority are started before the others
 */
const createRequestQueue = (minInterval) => {
    const waiting = [[], []];
    let next = 0;
    let timer;
    const run = () => {
        timer = undefined;
        const entry = waiting[0].shift() || waiting[1].shift();
        if (!entry) return;
        next = Date.now() + minInterval;
        entry();
        schedule();
    }
    const schedule = () => {
        if (timer !== undefined || (waiting[0].length + waiting[1].length) < 1) return;
        timer = window.setTimeout(run, Math.max(0, next - Date.now()));
    }
    return (requestFunction, priority) => {
        if (!(minInterval > 0)) return requestFunction();
        return new Promise((resolve, reject) => {
            waiting[priority ? 0 : 1].push(() => {
                try {
                    Promise.resolve(requestFunction()).then(resolve, reject);
                } catch (e) {
                    reject(e);
                }
            });
            schedule();
        });
    }
}

/**
 * create a function that loads an url into a new image
 * identical urls are only loaded once (many tiles share the same
 * image when AvNav zooms up lower layers)
 * @param minInterval minimal ms between requests
 * @param apiKey if set: load with fetch and send it as Authorization header
 * @returns {function(url,priority):Promise<HTMLImageElement>} rejects on errors
 */
const createLoader = (minInterval, apiKey) => {
    const queue = createRequestQueue(minInterval);
    const cache = new Map();
    const loadImage = (src) => new Promise((resolve, reject) => {
        //no crossOrigin: like AvNav itself, as not all servers send CORS headers (KNMI)
        const image = new Image();
        image.addEventListener('load', () => resolve(image), {once: true});
        image.addEventListener('error', () => reject(new Error("unable to load " + src)), {once: true});
        image.src = src;
    });
    const load = async (url, priority) => {
        if (!apiKey) return queue(() => loadImage(url), priority);
        const response = await queue(() => fetch(url, {headers: {Authorization: apiKey}}), priority);
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        try {
            return await loadImage(objectUrl);
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    };
    return (url, priority) => {
        let rt = cache.get(url);
        if (!rt) {
            rt = load(url, priority);
            rt.catch((e) => console.warn("radaroverlay: tile load failed", e.message));
            cache.set(url, rt);
            if (cache.size > 2000) cache.delete(cache.keys().next().value);
        }
        return rt;
    }
}

//------------------- tiles and animation --------------------------------
/*
 * AvNav (openlayers) only has a limited number of tile loads in parallel
 * for the complete map. Radar tiles that wait in our queue would block the
 * tiles of the chart below. So a radar tile is immediately "loaded" with a
 * transparent placeholder and the real image is set later (and replaced
 * for every animation step or when new radar data is available).
 */
const PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TILE_DISPOSED = 4; //openlayers TileState.EMPTY - set when the tile is released
//refresh check interval (ms) - looks for new radar data
const REFRESH_CHECK = 60 * 1000;

//all layers that currently animate (their contexts)
const animatedLayers = new Set();
let animationTimer;
let animationTick = 0;
let blankImage;

const getBlankImage = () => {
    if (!blankImage) {
        blankImage = document.createElement('canvas');
        blankImage.width = 256;
        blankImage.height = 256;
    }
    return blankImage;
}

const formatFrame = (context) => {
    const frame = context.frames[context.index];
    if (!frame) return "";
    const d = new Date(frame.time);
    const hm = String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0');
    //offset relative to the newest measured image ("now")
    let now;
    context.frames.forEach((f) => {
        if (!f.forecast) now = f;
    });
    const diff = now ? Math.round((frame.time - now.time) / 60000) : 0;
    if (diff === 0) return `jetzt ${hm}`;
    return diff < 0 ? `\u2212${-diff} min ${hm}` : `+${diff} min ${hm} Vorhersage`;
}

//a label on top of the map showing the time of the current animation step
let frameLabel;
const showFrameLabel = (label, forecast) => {
    if (api) api.setStoreData(api.getStoreBaseKey() + ".frame", label);
    if (!frameLabel) {
        if (!label) return;
        frameLabel = document.createElement('div');
        frameLabel.className = 'radaroverlayFrameLabel';
    }
    //place it on the map (not above the widgets), the map element can change
    const map = document.querySelector('.mapPage .mapFrame');
    if (map && frameLabel.parentElement !== map) map.appendChild(frameLabel);
    frameLabel.textContent = label;
    frameLabel.classList.toggle('forecast', !!forecast);
    frameLabel.style.display = label ? '' : 'none';
}

/**
 * set the image for the current frame at a tile
 */
const showTileFrame = (context, record) => {
    const image = record.images[context.index];
    const target = image || getBlankImage();
    //AvNav tiles draw the image returned by getImage (ownImage)
    if (record.tile.ownImage === target) return;
    record.tile.ownImage = target;
    record.tile.changed();
}

const showFrame = (context) => {
    for (let [key, record] of context.tiles) {
        if (record.tile.disposed || record.tile.getState() === TILE_DISPOSED) {
            context.tiles.delete(key);
            continue;
        }
        showTileFrame(context, record);
    }
}

/**
 * (re)load all frames for a tile
 */
const loadTileFrames = (context, record) => {
    const generation = context.generation;
    record.images = [];
    context.frames.forEach((frame, idx) => {
        context.load(context.source.frameUrl(record.src, frame, context), idx === context.index)
            .then((image) => {
                if (generation !== context.generation) return;
                record.images[idx] = image;
                if (idx === context.index) showTileFrame(context, record);
            })
            .catch(() => {
            });
    });
}

const animationStep = () => {
    animationTick++;
    let first = true;
    for (let context of animatedLayers) {
        const steps = context.frames.length + HOLD_TICKS;
        context.index = Math.min(animationTick % steps, context.frames.length - 1);
        showFrame(context);
        if (first) showFrameLabel(formatFrame(context), (context.frames[context.index] || {}).forecast);
        first = false;
    }
}

const updateAnimationTimer = () => {
    if (animationTimer !== undefined) {
        window.clearInterval(animationTimer);
        animationTimer = undefined;
    }
    if (animatedLayers.size < 1) {
        showFrameLabel("");
        return;
    }
    animationTimer = window.setInterval(animationStep, getSettings().interval * 1000);
}

const frameSignature = (frames) => frames.map((f) => f.key).join(",");

/**
 * compute the frames for a layer
 */
const computeFrames = async (options, context) => {
    const settings = getSettings();
    let frames = [];
    try {
        frames = await context.source.frames(options, context, settings);
    } catch (e) {
        console.warn("radaroverlay: unable to compute frames", e);
    }
    let current = -1;
    frames.forEach((frame, idx) => {
        if (!frame.forecast) current = idx;
    });
    if (!settings.animate && current >= 0) frames = [frames[current]];
    return {frames, animate: settings.animate && frames.length > 1};
}

/**
 * check for new radar data and reload the tiles if needed
 * this avoids reloading the complete map
 */
const refreshLayer = async (options, context, settingsChanged) => {
    if (settingsChanged) await context.source.prepare(options, context, getSettings());
    const {frames, animate} = await computeFrames(options, context);
    const wasAnimated = animatedLayers.has(context);
    if (!settingsChanged && frameSignature(frames) === frameSignature(context.frames)) return;
    context.frames = frames;
    if (animate) {
        animatedLayers.add(context);
        context.index = wasAnimated ? Math.min(context.index, frames.length - 1) : 0;
    } else {
        animatedLayers.delete(context);
        context.index = frames.length - 1;
    }
    if (animate !== wasAnimated) updateAnimationTimer();
    context.generation++;
    context.load = context.source.loader(context);
    showFrame(context); //removes released tiles
    for (let record of context.tiles.values()) {
        record.images = [];
        loadTileFrames(context, record);
    }
}

//------------------- generic radar layer -------------------------------
/**
 * build the layer callback for AvNav from a source description
 * a source has:
 *   prepare(options,context,settings)  async, set up the context
 *   tileUrl(coord,context)             url for a tile (without time)
 *   frames(options,context,settings)   async, list of {key,time,forecast,...}
 *                                      the last not forecast frame is the current one
 *   frameUrl(url,frame,context)        url for a tile in a frame
 *   loader(context)                    a loader from createLoader
 */
const createRadarLayer = (source) => async (options, context) => {
    context.source = source;
    context.tiles = new Map();
    context.generation = 0;
    await source.prepare(options, context, getSettings());
    const {frames, animate} = await computeFrames(options, context);
    context.frames = frames;
    context.index = animate ? 0 : frames.length - 1;
    context.load = source.loader(context);
    if (animate) {
        animatedLayers.add(context);
        updateAnimationTimer();
    }
    context.options = options;
    liveLayers.add(context);
    context.refreshTimer = window.setInterval(() => refreshLayer(options, context), REFRESH_CHECK);
    setActive(1);
    return {
        createTileUrlFunction: (layerOptions, originalTileUrlFunction, ctx) => {
            return (coord) => {
                //the original function checks the min/max zoom of the layer
                if (isInvalid(originalTileUrlFunction(coord))) return INVALID_URL;
                return source.tileUrl(coord, ctx);
            }
        },
        tileLoadFunction: async (tile, src, ctx) => {
            const image = tile.getImage();
            if (isInvalid(src) || ctx.frames.length < 1) {
                image.src = INVALID_URL;
                return;
            }
            const record = {tile, src, images: []};
            ctx.tiles.set(tile.tileCoord.join("/"), record);
            //let AvNav finish this tile at once, the radar image follows
            image.src = PLACEHOLDER;
            loadTileFrames(ctx, record);
        },
        finalizeFunction: async (ctx) => {
            window.clearInterval(ctx.refreshTimer);
            ctx.generation++;
            animatedLayers.delete(ctx);
            liveLayers.delete(ctx);
            ctx.tiles.clear();
            setActive(-1);
            updateAnimationTimer();
        }
        //no sequenceFunction: new data and settings are applied to the
        //existing tiles - a chart reload by AvNav would flicker
    };
}

//------------------- RainViewer ----------------------------------------
const rainViewerState = {
    lastFetch: 0,
    catalog: undefined, //{host,frames:[{time,path}]}
    pending: undefined
};

const fetchRainViewerCatalog = async () => {
    const now = Date.now();
    if (rainViewerState.catalog && (now - rainViewerState.lastFetch) < CATALOG_MAX_AGE) {
        return rainViewerState.catalog;
    }
    if (rainViewerState.pending) return rainViewerState.pending;
    rainViewerState.pending = (async () => {
        try {
            const response = await fetch(RAINVIEWER_CATALOG, {cache: 'no-store'});
            if (!response.ok) throw new Error(`${RAINVIEWER_CATALOG}: ${response.status}`);
            const catalog = await response.json();
            const past = (catalog.radar || {}).past || [];
            if (past.length < 1) throw new Error("no radar frames in RainViewer catalog");
            rainViewerState.catalog = {
                host: catalog.host,
                frames: past.map((f) => ({time: f.time * 1000, path: f.path}))
            };
        } catch (e) {
            //keep the last catalog (if any) - we may be offline
            console.warn("radaroverlay: unable to fetch RainViewer catalog", e);
        }
        rainViewerState.lastFetch = Date.now();
        rainViewerState.pending = undefined;
        return rainViewerState.catalog;
    })();
    return rainViewerState.pending;
}

const rainViewerSource = {
    prepare: async (options, context) => {
        //tile size 256, color scheme 2 (Universal Blue - the only free one), smooth=1, snow=1
        context.color = options.color || 2;
        context.tileOptions = options.tileoptions || "1_1";
    },
    tileUrl: (coord, context) => {
        const [z, x, y] = coord;
        return `${z}/${x}/${y}`;
    },
    frames: async (options, context, settings) => {
        const catalog = await fetchRainViewerCatalog();
        if (!catalog) return [];
        context.host = catalog.host;
        const latest = catalog.frames[catalog.frames.length - 1];
        return catalog.frames
            .filter((f) => f === latest || f.time >= latest.time - settings.past * 60000)
            .map((f) => ({...f, key: f.path}));
    },
    frameUrl: (url, frame, context) =>
        `${context.host}${frame.path}/256/${url}/${context.color}/${context.tileOptions}.png`,
    loader: () => createLoader(0)
};

//------------------- WMS (DWD, KNMI) ------------------------------------
const wmsBucket = () => Math.floor(Date.now() / WMS_REFRESH);

/**
 * a WMS based radar source
 * layer options (from plugin.json):
 *   url           the WMS base url (may already contain parameters like DATASET)
 *   wmslayer      the WMS layer name
 *   forecastlayer optional: WMS layer for forecast frames (on the same server)
 *   boundingbox   only tiles inside will be requested
 *   apikey        optional: sent as Authorization header (KNMI)
 *   usekey        optional: name of a settings value with the api key
 *   keyhost       optional: host name to use instead if an apikey is set
 *   mininterval   optional: minimal ms between tile requests (rate limited servers)
 *   keyinterval   optional: mininterval to use if an apikey is set
 */
const createWmsSource = (defaultLayer) => ({
    prepare: async (options, context, settings) => {
        context.apiKey = options.apikey || (options.usekey ? settings[options.usekey] : undefined);
        const base = new URL(options.url || options.href);
        //KNMI: the anonymous endpoint has a shared quota, with a key use the normal one
        if (context.apiKey && options.keyhost) base.hostname = options.keyhost;
        for (let [k, v] of Object.entries({
            SERVICE: "WMS",
            VERSION: "1.1.1",
            REQUEST: "GetMap",
            FORMAT: "image/png",
            TRANSPARENT: "TRUE",
            STYLES: "",
            SRS: "EPSG:3857",
            LAYERS: options.wmslayer || defaultLayer,
            WIDTH: "256",
            HEIGHT: "256"
        })) {
            base.searchParams.set(k, v);
        }
        context.base = base;
        context.forecastLayer = options.forecastlayer;
        //only request tiles that intersect the bounding box (in EPSG:3857 meters)
        const bbox = options.boundingbox;
        context.limits = bbox ? {
            minx: lonToX(parseFloat(bbox.minlon)), maxx: lonToX(parseFloat(bbox.maxlon)),
            miny: latToY(parseFloat(bbox.minlat)), maxy: latToY(parseFloat(bbox.maxlat))
        } : undefined;
        context.minInterval = parseInt((context.apiKey && options.keyinterval !== undefined) ?
            options.keyinterval : (options.mininterval || 0));
    },
    tileUrl: (coord, context) => {
        const [z, x, y] = coord; //y=0 is north
        const size = 2 * EARTH_HALF / (1 << z);
        const minx = -EARTH_HALF + x * size;
        const maxy = EARTH_HALF - y * size;
        const limits = context.limits;
        if (limits && (minx > limits.maxx || minx + size < limits.minx ||
            maxy - size > limits.maxy || maxy < limits.miny)) return INVALID_URL;
        const url = new URL(context.base);
        url.searchParams.set("BBOX", [minx, maxy - size, minx + size, maxy].join(","));
        return url.toString();
    },
    frames: async (options, context, settings) => {
        if (!settings.animate) {
            //no TIME parameter: the server delivers the latest image
            //the bucket avoids getting an old image from the browser cache
            const bucket = wmsBucket();
            return [{time: Date.now(), latest: true, bucket, key: "latest" + bucket}];
        }
        //the images are on a 5 minute grid, the newest one appears with some delay
        const now = Math.floor((Date.now() - WMS_DELAY) / WMS_STEP) * WMS_STEP;
        const rt = [];
        for (let t = now - settings.past * 60000; t <= now; t += WMS_STEP) {
            rt.push({time: t, key: String(t)});
        }
        if (context.forecastLayer) {
            for (let t = now + WMS_STEP; t <= now + settings.forecast * 60000; t += WMS_STEP) {
                rt.push({time: t, forecast: true, layer: context.forecastLayer, key: "f" + t});
            }
        }
        return rt;
    },
    frameUrl: (urlString, frame) => {
        const url = new URL(urlString);
        if (frame.latest) {
            url.searchParams.set("_avnav", frame.bucket);
            return url.toString();
        }
        url.searchParams.set("TIME", new Date(frame.time).toISOString().replace(/\.\d+Z$/, "Z"));
        if (frame.layer) url.searchParams.set("LAYERS", frame.layer);
        return url.toString();
    },
    loader: (context) => createLoader(context.minInterval, context.apiKey)
});

//------------------- settings dialog ------------------------------------
let closeDialog;
const showSettingsDialog = async (ev) => {
    if (closeDialog) {
        closeDialog();
        closeDialog = undefined;
    }
    closeDialog = await api.showDialog({
        title: "Radar",
        parameters: SETTINGS_PARAMETERS,
        values: getSettings(),
        buttons: [
            {name: 'DBReset', onClick: () => ({...DEFAULT_SETTINGS}), close: false},
            {name: 'DBCancel'},
            {
                name: 'DBOk', onClick: (event, values) => {
                    api.setLocalStorage(SETTINGS_KEY, {...getSettings(), ...values});
                    //apply the new settings to all radar layers without reloading the map
                    for (let context of liveLayers) {
                        refreshLayer(context.options, context, true);
                    }
                    updateAnimationTimer();
                }
            }
        ],
        onClose: () => {
            closeDialog = undefined;
        }
    }, ev);
}

//------------------- registration --------------------------------------
const SOURCES = {
    rainviewer: rainViewerSource,
    dwdradar: createWmsSource("dwd:Niederschlagsradar"),
    knmiradar: createWmsSource("RAD_NL25_PCP_CM")
};

export default async (pluginApi) => {
    api = pluginApi;
    for (let [name, source] of Object.entries(SOURCES)) {
        api.registerUserMapLayer('zxy', name, createRadarLayer(source));
    }
    const base = api.getStoreBaseKey();
    api.registerUserButton({
        name: 'radar',
        shortText: 'Radar',
        longText: 'Radar settings',
        icon: 'radar.svg',
        storeKeys: {
            frame: base + ".frame",
            active: base + ".active"
        },
        updateFunction: (state) => ({
            visible: !!state.active,
            toggle: !!state.frame,
            shortText: state.frame || 'Radar'
        }),
        onClick: (ev) => showSettingsDialog(ev)
    }, 'navpage');
    console.log(`${api.getPluginName()}: registered radar layers ${Object.keys(SOURCES).join(",")}`);
}
