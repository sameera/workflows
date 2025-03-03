import {
    Inject,
    Injectable,
    InjectionToken,
    Injector,
    Optional,
    ProviderToken,
    Type,
} from "@angular/core";
import { Actions, createEffect } from "@ngrx/effects";
import { Store } from "@ngrx/store";
import { asapScheduler, Observable, Subject, Subscriber } from "rxjs";
import { filter, map, subscribeOn, takeWhile } from "rxjs/operators";

import {
    EventCreator,
    occurenceOf,
    onEvent,
    RxEvent,
} from "@cloudextend/contrib/events";
import { navigation } from "@cloudextend/contrib/routing";

import { Workflow } from "./workflow";
import { WorkflowContext } from "./workflow-context";
import { WorkflowStep } from "./workflow-step";
import { skipSteps, nextStep, previousStep, goto } from "./workflow.events";
import { WorkflowUpdate, WorkflowUpdateType } from "./workflow-update";
import { blockedUntil } from "./workflow.events.internal";
import { contextUpdated, idle } from ".";

export const CE_WF_FALLBACK_PATH = new InjectionToken("CloudExtend_Home_Path");

export type WorkflowBuilder = (event: RxEvent) => Workflow;

interface ExecutingWorkflow {
    context: WorkflowContext;
    nextStepIndex: number;
    stepIndexByLabel: Map<string, number>;
    doNotIndex?: boolean;
    blockingEvents?: Set<string>;
    workflow: Workflow;
    updates$: Subject<WorkflowUpdate<WorkflowContext>>;
}

@Injectable({ providedIn: "root" })
export class WorkflowEngine {
    constructor(
        private readonly actions$: Actions,
        private readonly store: Store,
        private readonly injector: Injector,
        @Optional()
        @Inject(CE_WF_FALLBACK_PATH)
        fallbackPath: string
    ) {
        this.homePath = fallbackPath ?? "/";
    }

    private readonly homePath: string;

    onNextStep$ = createEffect(
        () =>
            this.actions$.pipe(
                onEvent(nextStep),
                map(() => {
                    this.gotoNextStep();
                    this.activateNextStep();
                })
            ),
        { dispatch: false }
    );

    onPreviousStep$ = createEffect(
        () =>
            this.actions$.pipe(
                onEvent(previousStep),
                map(() => {
                    this.gotoPreviousStep();
                    this.activateNextStep();
                })
            ),
        { dispatch: false }
    );

    onSkipSteps$ = createEffect(
        () =>
            this.actions$.pipe(
                onEvent(skipSteps),
                map(event => {
                    this.skipSteps(event.value);
                    this.activateNextStep();
                })
            ),
        { dispatch: false }
    );

    onGoTo$ = createEffect(
        () =>
            this.actions$.pipe(
                onEvent(goto),
                map(event => {
                    this.gotoLabeledStep(event.value);
                    this.activateNextStep();
                })
            ),
        { dispatch: false }
    );

    onBlockedUntil$ = createEffect(
        () =>
            this.actions$.pipe(
                filter(
                    event =>
                        !!this.current &&
                        !!this.current.blockingEvents &&
                        !!(event as RxEvent).verb &&
                        this.current.blockingEvents.has((event as RxEvent).verb)
                ),
                map(event => {
                    const verb = (event as RxEvent).verb;

                    const current = this.current;
                    const blockingEvents = current?.blockingEvents;
                    if (!current) return; // only to appease strict type checking

                    if (!!blockingEvents) {
                        blockingEvents.delete(verb);
                        // If there are more events blocking the flow, exit.
                        if (blockingEvents.size > 0) return;
                    }

                    const currentWf = current.workflow;
                    current.updates$.next({
                        context: current.context,
                        type: WorkflowUpdateType.endStep,
                        stepIndex: current.nextStepIndex,
                        stepLabel:
                            currentWf.steps[current.nextStepIndex]?.label,
                        workflowName: currentWf.name,
                    });
                    this.store.dispatch(idle(currentWf.name));

                    this.gotoNextStep();
                    this.activateNextStep();
                })
            ),
        { dispatch: false }
    );

    onWorkflowTrigger$ = createEffect(
        () =>
            this.actions$.pipe(
                filter(
                    event =>
                        !!(event as RxEvent).verb &&
                        this.workflowBuilderByEvent.has((event as RxEvent).verb)
                ),
                map(event => {
                    const builder = this.workflowBuilderByEvent.get(
                        (event as RxEvent).verb
                    );
                    return this.executeWorkflow(builder!(event as RxEvent));
                })
            ),
        { dispatch: false }
    );

    private current: ExecutingWorkflow | undefined;

    private readonly workflowBuilderByEvent = new Map<
        string,
        WorkflowBuilder
    >();

    public executeWorkflow<T extends WorkflowContext = WorkflowContext>(
        workflow: Workflow<T>,
        initialContext?: Partial<T>
    ): Observable<WorkflowUpdate<T>> {
        const context = {
            ...initialContext,
            isBackgroundWorkflow: workflow.isBackgroundWorkflow,
            workflowName: workflow.name,
            store: this.store,
        } as T;

        const stepIndexByLabel = workflow.doNotIndex
            ? new Map<string, number>()
            : WorkflowEngine.createStepIndexByLabelMap(workflow.steps);

        const updates$ = new Subject<WorkflowUpdate<T>>();

        this.current = {
            updates$: updates$ as unknown as Subject<WorkflowUpdate>,
            workflow: workflow as Workflow,
            context,
            stepIndexByLabel,
            nextStepIndex: 0,
            doNotIndex: workflow.doNotIndex,
        };

        new Observable(() => {
            updates$.next({
                context,
                type: WorkflowUpdateType.beginWorkflow,
                workflowName: workflow.name,
            } as WorkflowUpdate<T>);
            this.activateNextStep();
        })
            .pipe(subscribeOn(asapScheduler))
            .subscribe();

        return updates$;
    }

    public registerWorkflow(
        event: EventCreator,
        builder: (event: RxEvent) => Workflow
    ) {
        if (!event?.verb) {
            throw new Error("Triggering event cannot be null or undefined.");
        }
        if (!builder) {
            throw new Error("The builder cannot be null or undefined.");
        }

        this.workflowBuilderByEvent.set(event.verb, builder);
    }

    private activateNextStep(): void {
        const current = this.current;

        if (!current) {
            this.executeOnCompleteAction();
            return;
        } else if (current.nextStepIndex >= current.workflow.steps.length) {
            current.nextStepIndex = 0;
            this.executeOnCompleteAction();
            current.updates$.next({
                context: current.context,
                type: WorkflowUpdateType.endWorkflow,
                workflowName: current.workflow.name,
            });
            current.updates$.complete();

            delete this.current;
            return;
        }

        if (current.nextStepIndex < 0) {
            current.nextStepIndex = 0;
        }

        const currentStepIndex = current.nextStepIndex;
        const currentStep = current.workflow.steps[currentStepIndex];

        current.updates$.next({
            context: current.context,
            type: WorkflowUpdateType.beginStep,
            stepIndex: currentStepIndex,
            stepLabel: currentStep.label,
            workflowName: current.workflow.name,
        });

        // Stay subscribed to a step only if it has not been navigated off of externally (by raising
        // a WF event extenrally, or it's not waiting for a specific event).
        const staySubscribed = () =>
            currentStepIndex === current.nextStepIndex &&
            !current.blockingEvents?.size;

        const deps = !currentStep.dependencies
            ? []
            : currentStep.dependencies.map(d => this.injector.get(d));

        let autoforward = true;
        currentStep
            .activate(current.context, ...deps)
            .pipe(takeWhile(staySubscribed))
            .subscribe({
                next: event => {
                    if (occurenceOf(nextStep, event)) {
                        this.gotoNextStep();
                    } else if (occurenceOf(previousStep, event)) {
                        this.gotoPreviousStep();
                    } else if (occurenceOf(skipSteps, event)) {
                        this.skipSteps(
                            (event as ReturnType<typeof skipSteps>).value
                        );
                    } else if (occurenceOf(goto, event)) {
                        this.gotoLabeledStep(
                            (event as ReturnType<typeof goto>).value
                        );
                    } else if (occurenceOf(navigation, event)) {
                        this.store.dispatch(event);
                        autoforward = false;
                    } else if (occurenceOf(contextUpdated, event)) {
                        Object.assign(
                            current.context,
                            (event as ReturnType<typeof contextUpdated>).update
                        );
                    } else if (occurenceOf(blockedUntil, event)) {
                        autoforward = false;
                        current.blockingEvents = new Set<string>(
                            (event as ReturnType<typeof blockedUntil>).verbs
                        );
                        // don't dispatch endStep event
                        return;
                    } else {
                        this.store.dispatch(event);
                    }

                    current.updates$.next({
                        context: current.context,
                        type: WorkflowUpdateType.endStep,
                        stepIndex: currentStepIndex,
                        stepLabel: currentStep.label,
                        workflowName: current.workflow.name,
                    });
                },
                error: current.updates$.error,
                complete: () => {
                    if (autoforward) {
                        if (current.nextStepIndex === currentStepIndex) {
                            current.nextStepIndex++;
                        }
                        this.activateNextStep();
                    }
                },
            });
    }

    private executeOnCompleteAction(): void {
        if (this.current?.workflow.onCompletion) {
            const context = this.current.context;
            const completionEvents =
                this.current.workflow.onCompletion(context);

            if (Array.isArray(completionEvents)) {
                completionEvents.forEach(a => this.store.dispatch(a));
            } else {
                this.store.dispatch(completionEvents);
            }
        } else {
            this.store.dispatch(
                navigation("#workflows/engine", {
                    pathSegments: [this.homePath],
                })
            );
        }
    }

    private skipSteps(skips: number) {
        if (!this.current) return -1;

        this.current.nextStepIndex += 1 + skips;
        return this.current.nextStepIndex;
    }

    private gotoLabeledStep(label: string) {
        if (!this.current) {
            throw new Error(
                `There is no active workflow. Cannot go to step ${label}`
            );
        }

        if (this.current.doNotIndex) {
            throw new Error(
                `Unable to navigate to '${label}' step.` +
                    "The workflow had disabled indexing and therefore " +
                    "'goto' events are unsupported for this workflow."
            );
        }

        const stepIndex = this.current.stepIndexByLabel.get(label);

        if (typeof stepIndex === "undefined") {
            throw new Error(`Attempted to go to an unknown step '${label}'.`);
        }

        return (this.current.nextStepIndex = stepIndex);
    }

    private gotoPreviousStep() {
        if (!this.current) return -1;

        this.current.nextStepIndex--;
        return this.current.nextStepIndex;
    }

    private gotoNextStep() {
        if (!this.current) return -1;

        this.current.nextStepIndex++;
        return this.current.nextStepIndex;
    }

    private static createStepIndexByLabelMap<
        T extends WorkflowContext = WorkflowContext
    >(workflowSteps: WorkflowStep<T>[]): Map<string, number> {
        const stepIndexMap = new Map<string, number>();
        workflowSteps.forEach((step, index) =>
            stepIndexMap.set(step.label, index)
        );

        return stepIndexMap;
    }
}
