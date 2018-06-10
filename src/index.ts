import {
    ClientConfig,
    Outcomes,
    CompleteExperimentsRequest,
    StartExperimentsRequest,
    StartExperimentsResponse
} from "./common/ClientAPI";

import { startHTMLExperiments } from "./html";

import {
    http,
    uuidv4,
    log,
    error,
    mapObject,
    getOwnPropertyValues,
    getLocalLanguage,
    getTimeZoneOffset,
    debounce
} from "./util";

function api(path: string) {
    return `https://2vyiuehl9j.execute-api.us-east-2.amazonaws.com/prod/${path}`;
}

function outcomesUrl(appKey: string) {
    return `https://s3.us-east-2.amazonaws.com/autotune-outcomes/${appKey}.json`;
}

const state: {
    appKey: string;
    experiments: { [name: string]: Experiment };
    defaultCompletions: { [name: string]: Experiment };
    queuedCompletedExperiments: { [name: string]: Experiment };
    queuedStartedExperiments: { [name: string]: Experiment };
} = {
    appKey: "",
    experiments: {},
    defaultCompletions: {},
    queuedCompletedExperiments: {},
    queuedStartedExperiments: {}
};

function startExperiment(theExperiment: Experiment): void {
    state.queuedStartedExperiments[theExperiment.name] = theExperiment;
    startExperimentsDebounced();
}

const startExperimentsDebounced = debounce(() => {
    let experiments = mapObject(state.queuedStartedExperiments, e => ({
        instanceKey: e.key,
        options: e.options,
        pick: e.pick,
        pickedBest: e.pickedBest
    }));

    log("Starting experiments", experiments);

    state.queuedStartedExperiments = {};

    http(
        "POST",
        api("/startExperiments"),
        {
            version: 2,
            appKey: state.appKey,
            experiments,
            ctx: {
                lang: getLocalLanguage(),
                tzo: getTimeZoneOffset()
            }
        },
        () => {
            return;
        },
        e => error("Failed to start experiments", e)
    );
}, 100);

function completeExperiment(theExperiment: Experiment, then: CompletionCallback | undefined): void {
    state.queuedCompletedExperiments[theExperiment.name] = theExperiment;
    completeExperimentsDebounced(then);
}

const completeExperimentsDebounced = debounce((then: CompletionCallback | undefined) => {
    const experiments = getOwnPropertyValues(state.queuedCompletedExperiments);

    state.queuedCompletedExperiments = {};

    const experimentsByKey: CompleteExperimentsRequest["experiments"] = {};
    experiments.forEach(e => (experimentsByKey[e.key] = { pick: e.pick, payoff: e.payoff }));

    log("Completing experiments", experimentsByKey);

    function callThen() {
        if (then !== undefined) {
            then();
        }
    }

    http(
        "POST",
        api("/completeExperiments"),
        {
            version: 1,
            appKey: state.appKey,
            experiments: experimentsByKey
        },
        () => callThen(),
        e => {
            error("Failed to complete experiments", e);
            callThen();
        }
    );
}, 10);

function finishInit(outcomes: Outcomes): void {
    try {
        Object.getOwnPropertyNames(outcomes).forEach(name => {
            // If there's already an experiment there, it's already running,
            // so don't overwrite it.
            if (state.experiments[name] !== undefined) return;

            const { bestOption, epsilon } = outcomes[name];
            state.experiments[name] = new Experiment(name, bestOption, epsilon);
        });

        startHTMLExperiments();
    } catch (e) {
        error("Couldn not finish init", e);
    }
}

export function initialize(appKey: string, then: () => void, outcomes: Outcomes = undefined): void {
    if (state.appKey !== "") {
        log("Initialized more than once");
        return;
    }

    log("Initialize", appKey);

    state.appKey = appKey;

    if (outcomes !== undefined) {
        finishInit(outcomes);
        return;
    }

    http(
        "GET",
        outcomesUrl(appKey),
        undefined,
        o => {
            log("Got outcomes", o);
            finishInit(o);
            then();
        },
        e => {
            error("Could not get outcomes", e);
            finishInit({});
            then();
        }
    );
}

function experiment(name: string): Experiment {
    let ex = state.experiments[name] as Experiment;
    if (ex === undefined) {
        ex = state.experiments[name] = new Experiment(name);
    }
    return ex;
}

function storageKey(path: string): string {
    return `autotune.v1.${state.appKey}.${path}`;
}
export class Experiment {
    private static picks: { [name: string]: string } = {};

    private static loadPick(name: string): string | undefined {
        let pick = Experiment.picks[name];
        if (pick === undefined) {
            try {
                const savedPicks = localStorage[storageKey("picks")];
                Experiment.picks = savedPicks === undefined ? {} : JSON.parse(savedPicks);
            } catch (e) {
                error("Could not load saved experiment picks:", e.message);
                Experiment.picks = {};
            }
            pick = Experiment.picks[name];
        }
        return pick;
    }

    private static savePick(name: string, pick: string) {
        Experiment.picks[name] = pick;
        Experiment.persistPicks();
    }

    private static persistPicks = debounce(() => {
        log("Writing saved experiment picks");
        try {
            localStorage[storageKey("picks")] = JSON.stringify(Experiment.picks);
        } catch (e) {
            error("Could not save experiment picks:", e.message);
        }
    }, 100);

    payoff: number;
    pick?: string;
    pickedBest?: boolean;
    options: string[];

    readonly key: string;

    constructor(
        public readonly name: string,
        readonly bestOption: string | undefined = undefined,
        readonly epsilon: number = 1
    ) {
        this.key = uuidv4();
    }

    private setValueAndStartExperiment(value: string, pickedBest: boolean): string {
        this.pickedBest = pickedBest;
        if (this.pick === undefined) {
            this.pick = value;
            startExperiment(this);
        }
        return this.pick;
    }

    complete(payoff: number = 1, then: CompletionCallback | undefined) {
        this.payoff = payoff;
        completeExperiment(this, then);
    }

    // FIXME: This shouldn't be in here.  Maybe a CoinFlipExperiment subclass?
    flipCoin(): boolean {
        return this.oneOf("true" as any, "false" as any) === "true";
    }

    oneOf(...options: string[]): string {
        this.options = options;

        const savedPick = Experiment.loadPick(this.name);
        if (savedPick !== undefined && this.options.indexOf(savedPick) !== -1) {
            return this.setValueAndStartExperiment(savedPick, savedPick === this.bestOption);
        }

        const pickRandom = this.bestOption === undefined || Math.random() < this.epsilon;
        let pick: string;
        if (pickRandom) {
            pick = options[Math.floor(Math.random() * options.length)];
        } else {
            pick = this.bestOption;
        }

        Experiment.savePick(this.name, pick);
        return this.setValueAndStartExperiment(pick, !pickRandom);
    }
}

export function flipCoin(experimentName: string): boolean {
    const ex = experiment(experimentName);
    state.defaultCompletions[experimentName] = ex;
    return ex.flipCoin();
}

export function oneOf(experimentName: string, options: string[]): string;
export function oneOf<T>(experimentName: string, options: { [label: string]: T }): T;
export function oneOf<T>(experimentName: string, options: string[] | { [label: string]: T }): T | string {
    const ex = experiment(experimentName);
    state.defaultCompletions[experimentName] = ex;

    const optionsIsArray = Object.prototype.toString.call(options) === "[object Array]";
    if (optionsIsArray) {
        return ex.oneOf(...(options as string[]));
    } else {
        const choice = ex.oneOf(...Object.getOwnPropertyNames(options));
        return (options as { [label: string]: T })[choice];
    }
}

export type CompletionCallback = () => void;

export function complete(then?: CompletionCallback): void;
export function complete(score: number, then: () => CompletionCallback | undefined): void;
export function complete(scoreOrThen: number | CompletionCallback | undefined, maybeThen?: CompletionCallback): void {
    let score: number;
    if (typeof scoreOrThen === "number") {
        score = scoreOrThen;
    } else {
        score = 1;
    }

    let then: CompletionCallback | undefined;
    if (typeof scoreOrThen === "function") {
        then = scoreOrThen;
    } else {
        then = maybeThen;
    }

    const completions = state.defaultCompletions;
    Object.getOwnPropertyNames(completions).forEach(name => completions[name].complete(score, then));
}

if (typeof window !== "undefined" && typeof (window as any).autotuneConfig !== "undefined") {
    const config: ClientConfig = (window as any).autotuneConfig;
    initialize(
        config.appKey,
        () => {
            return;
        },
        config.outcomes
    );
}
