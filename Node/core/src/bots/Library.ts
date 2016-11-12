// 
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.
// 
// Microsoft Bot Framework: http://botframework.com
// 
// Bot Builder SDK Github:
// https://github.com/Microsoft/BotBuilder
// 
// Copyright (c) Microsoft Corporation
// All rights reserved.
// 
// MIT License:
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
// 
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED ""AS IS"", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//

import { Dialog, IRecognizeDialogContext } from '../dialogs/Dialog';
import { SimpleDialog, IDialogWaterfallStep, createWaterfall } from '../dialogs/SimpleDialog';
import { ActionSet, IDialogActionOptions, IFindActionRouteContext, IActionRouteData } from '../dialogs/ActionSet';
import { IRecognizeContext, IntentRecognizerSet, IIntentRecognizer, IIntentRecognizerResult } from '../dialogs/IntentRecognizerSet';
import { Session } from '../Session'; 
import * as consts from '../consts';
import * as utils from '../utils';
import * as logger from '../logger';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as async from 'async';

export interface IDialogMap {
    [id: string]: Dialog;
}

export interface ILibraryMap {
    [name: string]: Library;
}

export interface IRouteResult {
    score: number;
    libraryName: string;
    label?: string;
    routeType?: string;
    routeData?: any;
}

export interface IFindRoutesHandler {
    (session: Session, callback: (err: Error, routes: IRouteResult[]) => void): void;
}

export interface ISelectRouteHandler {
    (session: Session, route: IRouteResult): void;
}

export class Library extends EventEmitter {
    static RouteTypes = {
        GlobalAction: 'GlobalAction',
        StackAction: 'StackAction',
        ActiveDialog: 'ActiveDialog'
    };

    private dialogs = <IDialogMap>{};
    private libraries = <ILibraryMap>{};
    private actions = new ActionSet();
    private recognizers = new IntentRecognizerSet();
    private _localePath: string;
    private _onFindRoutes: IFindRoutesHandler;
    private _onSelectRoute: ISelectRouteHandler;

    constructor(public readonly name: string) {
        super();
    }

    //-------------------------------------------------------------------------
    // Localization
    //-------------------------------------------------------------------------

    /** Gets/sets the path to the libraries localization folder. */
    public localePath(path?: string): string {
        if (path) {
            this._localePath = path;
        }
        return this._localePath;
    }

    //-------------------------------------------------------------------------
    // Recognition
    //-------------------------------------------------------------------------

    /** Attempts to recognize the top intent for the current message. */
    public recognize(session: Session, callback: (err: Error, result: IIntentRecognizerResult) => void): void {
        var context: IRecognizeContext = {
            message: session.message,
            locale: session.preferredLocale()
        }
        this.recognizers.recognize(context, callback);
    }

    /** Adds a recognizer to the libraries intent recognizer set. */
    public recognizer(plugin: IIntentRecognizer): this {
        // Append recognizer
        this.recognizers.recognizer(plugin);
        return this;
    }

    //-------------------------------------------------------------------------
    // Routing
    //-------------------------------------------------------------------------

    /** Finds candidate routes. */
    public findRoutes(session: Session, callback: (err: Error, routes: IRouteResult[]) => void): void {
        if (this._onFindRoutes) {
            this._onFindRoutes(session, callback);
        } else {
            this.defaultFindRoutes(session, callback);
        }
    }

    /** Lets a developer override the libraries default search logic. */
    public onFindRoutes(handler: IFindRoutesHandler): void {
        this._onFindRoutes = handler;
    }

    /** Selects a route returned by findRoute(). */
    public selectRoute(session: Session, route: IRouteResult): void {
        if (this._onSelectRoute) {
            this._onSelectRoute(session, route);
        } else {
            this.defaultSelectRoute(session, route);
        }
    }

    /** Lets a developer override the libraries default selection logic. */
    public onSelectRoute(handler: ISelectRouteHandler): void {
        this._onSelectRoute = handler;
    }

    /** Checks to see if the active dialog is from the current library and gets its confidence score for the utterance. */
    public findActiveDialogRoutes(session: Session, topIntent: IIntentRecognizerResult, callback: (err: Error, routes: IRouteResult[]) => void, dialogStack?: IDialogState[]): void {
        // Find stack to search over
        if (!dialogStack) {
            dialogStack = session.dialogStack();
        }

        // Ensure that the active dialog is for this library 
        var results = Library.addRouteResult({ score: 0.0, libraryName: this.name });
        var entry = Session.activeDialogStackEntry(dialogStack);
        var parts: string[] = entry ? entry.id.split(':') : null;
        if (parts && parts[0] == this.name) {
            // Get the dialog (if it exists)
            var dialog = this.dialog(parts[1]);
            if (dialog) {
                // Call recognize for the active dialog
                var context: IRecognizeDialogContext = {
                    message: session.message,
                    locale: session.preferredLocale(),
                    intent: topIntent,
                    dialogData: entry.state,
                    activeDialog: true
                };
                dialog.recognize(context, (err, result) => {
                    if (!err) {
                        if (result.score < 0.2) {
                            // The active dialog should always have some score otherwise it
                            // can't ensure that its route data will be properly round tripped.
                            result.score = 0.2;
                        }
                        callback(null, Library.addRouteResult({
                            score: result.score,
                            libraryName: this.name,
                            label: 'active_dialog_label',
                            routeType: Library.RouteTypes.ActiveDialog,
                            routeData: result
                        }, results));
                    } else {
                        callback(err, null);
                    }
                });
            } else {
                logger.warn(session, "Active dialog '%s' not found in library.", entry.id);
                callback(null, results);
            }
        } else {
            callback(null, results);
        }
    }

    /** Routes the received message to the active dialog. */
    public selectActiveDialogRoute(session: Session, route: IRouteResult, newStack?: IDialogState[]): void {
        if (!route || route.libraryName !== this.name || route.routeType !== Library.RouteTypes.ActiveDialog) {
            throw new Error('Invalid route type passed to Library.selectActiveDialogRoute().')
        }

        // Optionally switch stacks
        if (newStack) {
            session.dialogStack(newStack);
        }

        // Route to the active dialog.
        session.routeToActiveDialog(route.routeData);
    }

    /** Searches for any stack actions that have been triggered for the library. */
    public findStackActionRoutes(session: Session, topIntent: IIntentRecognizerResult, callback: (err: Error, routes: IRouteResult[]) => void, dialogStack?: IDialogState[]): void {
        // Find stack to search over
        if (!dialogStack) {
            dialogStack = session.dialogStack();
        }        

        // Search all stack entries in parallel
        var results = Library.addRouteResult({ score: 0.0, libraryName: this.name });
        var context: IFindActionRouteContext = {
            message: session.message,
            locale: session.preferredLocale(),
            intent: topIntent,
            libraryName: this.name,
            routeType: Library.RouteTypes.StackAction
        };
        async.forEachOf((dialogStack || []).reverse(), (entry: IDialogState, index: number, next: ErrorCallback) => {
            // Filter to library.
            var parts = entry.id.split(':');
            if (parts[0] == this.name) {
                var dialog = this.dialog(parts[1]);
                if (dialog) {
                    // Find trigered actions
                    dialog.findActionRoutes(context, (err, ra) => {
                        if (!err) {
                            for (var i = 0; i < ra.length; i++) {
                                var r = ra[i];
                                if (r.routeData) {
                                    (<IActionRouteData>r.routeData).dialogId = entry.id;
                                    (<IActionRouteData>r.routeData).dialogIndex = index;
                                }
                                results = Library.addRouteResult(r, results);
                            }
                        }
                        next(err);
                    });
                } else {
                    logger.warn(session, "Dialog '%s' not found in library.", entry.id);
                    next(null);
                }
            } else {
                next(null);
            }
        }, (err) => {
            if (!err) {
                callback(null, results);
            } else {
                callback(err, null);
            }
        });
    }

    /** Routes the received message to an action on the dialog stack. */
    public selectStackActionRoute(session: Session, route: IRouteResult, newStack?: IDialogState[]): void {
        if (!route || route.libraryName !== this.name || route.routeType !== Library.RouteTypes.StackAction) {
            throw new Error('Invalid route type passed to Library.selectStackActionRoute().')
        }

        // Optionally switch stacks
        if (newStack) {
            session.dialogStack(newStack);
        }

        // Route to triggered action
        var routeData = <IActionRouteData>route.routeData;
        var parts = routeData.dialogId.split(':');
        this.dialog(parts[1]).selectActionRoute(session, route);
    }

    /** Searches for any global actions that have been triggered for the library. */
    public findGlobalActionRoutes(session: Session, topIntent: IIntentRecognizerResult, callback: (err: Error, routes: IRouteResult[]) => void): void {
        var results = Library.addRouteResult({ score: 0.0, libraryName: this.name });
        var context: IFindActionRouteContext = {
            message: session.message,
            locale: session.preferredLocale(),
            intent: topIntent,
            libraryName: this.name,
            routeType: Library.RouteTypes.GlobalAction
        };
        this.actions.findActionRoutes(context, (err, ra) => {
            if (!err) {
                for (var i = 0; i < ra.length; i++) {
                    var r = ra[i];
                    results = Library.addRouteResult(r, results);
                }
                callback(null, results);
            } else {
                callback(err, null);
            }
        });
    }

    /** Routes the received message to one of the libraries global actions. */
    public selectGlobalActionRoute(session: Session, route: IRouteResult): void {
        if (!route || route.libraryName !== this.name || route.routeType !== Library.RouteTypes.GlobalAction) {
            throw new Error('Invalid route type passed to Library.selectGlobalActionRoute().')
        }

        // Route to triggered action
        this.actions.selectActionRoute(session, route);
    }

    /** Libraries default logic for finding candidate routes. */
    private defaultFindRoutes(session: Session, callback: (err: Error, routes: IRouteResult[]) => void): void {
        var results = Library.addRouteResult({ score: 0.0, libraryName: this.name });
        this.recognize(session, (err, topIntent) => {
            if (!err) {
                async.parallel([
                    (cb) => {
                        // Check the active dialogs score
                        this.findActiveDialogRoutes(session, topIntent, (err, routes) => {
                            if (!err && routes) {
                                routes.forEach((r) => results = Library.addRouteResult(r, results));
                            }
                            cb(err);
                        });
                    },
                    (cb) => {
                        // Search for triggered stack actions.
                        this.findStackActionRoutes(session, topIntent, (err, routes) => {
                            if (!err && routes) {
                                routes.forEach((r) => results = Library.addRouteResult(r, results));
                            }
                            cb(err);
                        });
                    },
                    (cb) => {
                        // Search for global actions.
                        this.findGlobalActionRoutes(session, topIntent, (err, routes) => {
                            if (!err && routes) {
                                routes.forEach((r) => results = Library.addRouteResult(r, results));
                            }
                            cb(err);
                        });
                    }
                ], (err) => {
                    if (!err) {
                        callback(null, results);
                    } else {
                        callback(err, null);
                    }
                });
            } else {
                callback(err, null);
            }
        });
    }

    /** Libraries default logic for selecting a route returned by findRoutes(). */
    private defaultSelectRoute(session: Session, route: IRouteResult): void {
        switch (route.routeType || '') {
            case Library.RouteTypes.ActiveDialog:
                this.selectActiveDialogRoute(session, route);
                break;
            case Library.RouteTypes.StackAction:
                this.selectStackActionRoute(session, route);
                break;
            case Library.RouteTypes.GlobalAction:
                this.selectGlobalActionRoute(session, route);
                break;
            default:
                throw new Error('Invalid route type passed to Library.selectRoute().');
        }
    }

    /** Conditionally adds a route with a higher confidence to a list of candidate routes. */
    static addRouteResult(route: IRouteResult, current?: IRouteResult[]): IRouteResult[] {
        if (!current || current.length < 1 || route.score > current[0].score) {
            current = [route];
        } else if (route.score == current[0].score) {
            current.push(route);
        }
        return current;
    }

    //-------------------------------------------------------------------------
    // Dialogs
    //-------------------------------------------------------------------------
    
    /** Adds or looks up a dialog within the library. */
    public dialog(id: string, dialog?: Dialog | IDialogWaterfallStep[] | IDialogWaterfallStep): Dialog {
        var d: Dialog;
        if (dialog) {
            // Fixup id
            if (id.indexOf(':') >= 0) {
                id = id.split(':')[1];
            }

            // Ensure unique
            if (this.dialogs.hasOwnProperty(id)) {
                throw new Error("Dialog[" + id + "] already exists in library[" + this.name + "].")
            }

            // Wrap dialog and save
            if (Array.isArray(dialog)) {
                d = new SimpleDialog(createWaterfall(dialog));
            } else if (typeof dialog == 'function') {
                d = new SimpleDialog(createWaterfall([<any>dialog]));
            } else {
                d = <any>dialog;
            }
            this.dialogs[id] = d;
        } else if (this.dialogs.hasOwnProperty(id)) {
            d = this.dialogs[id];
        }
        return d;
    }

    /** Searches for a dialog in the library hierarchy. */
    public findDialog(libName: string, dialogId: string): Dialog {
        var d: Dialog;
        var lib = this.library(libName);
        if (lib) {
            d = lib.dialog(dialogId);
        }
        return d;
    }

    /** Enumerates all of the libraries dialogs. */
    public forEachDialog(callback: (dialog: Dialog, id: string) => void): void {
        for (var id in this.dialogs) {
            callback(this.dialog(id), id);
        }
    }

    //-------------------------------------------------------------------------
    // Child Libraries
    //-------------------------------------------------------------------------

    /** Adds a child library to the hierarchy or looks up a library given its name. */
    public library(lib: Library|string): Library {
        var l: Library;
        if (typeof lib === 'string') {
            if (lib == this.name) {
                l = this;
            } else if (this.libraries.hasOwnProperty(lib)) {
                l = this.libraries[lib];
            } else {
                // Search for lib
                for (var name in this.libraries) {
                    l = this.libraries[name].library(lib);
                    if (l) {
                        break;
                    }
                }
            }
        } else {
            // Save library
            l = this.libraries[lib.name] = <Library>lib;
        }
        return l;
    }

    /** Enumerates the libraries immediate child libraries. */
    public forEachLibrary(callback: (library: Library) => void): void {
        for (var lib in this.libraries) {
            callback(this.libraries[lib]);
        }
    }

    /** Returns a list of unique libraries within the hierarchy. */
    public libraryList(reverse = false): Library[] {
        var list = <Library[]>[];
        var added: { [name:string]: boolean; } = {};
        function addChildren(lib: Library) {
            if (!added.hasOwnProperty(lib.name)) {
                added[lib.name] = true;
                if (!reverse) {
                    list.push(lib);
                }
                lib.forEachLibrary((child) => addChildren(child));
                if (reverse) {
                    list.push(lib);
                }
            }
        }
        addChildren(this);
        return list;
    }

    //-------------------------------------------------------------------------
    // Global Actions
    //-------------------------------------------------------------------------

    public beginDialogAction(name: string, id: string, options?: IDialogActionOptions): this {
        this.actions.beginDialogAction(name, id, options);
        return this;
    }

    public endConversationAction(name: string, msg?: string|string[]|IMessage|IIsMessage, options?: IDialogActionOptions): this {
        this.actions.endConversationAction(name, msg, options);
        return this;
    }
    
}

export var systemLib = new Library(consts.Library.system);
systemLib.localePath(path.join(__dirname, '../locale/'));