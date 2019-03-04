var idb = (function (exports) {
    'use strict';

    const instanceOfAny = (object, constructors) => constructors.some(c => object instanceof c);

    let idbProxyableTypes;
    let cursorAdvanceMethods;
    // This is a function to prevent it throwing up in node environments.
    function getIdbProxyableTypes() {
        if (!idbProxyableTypes) {
            idbProxyableTypes = [IDBDatabase, IDBObjectStore, IDBIndex, IDBCursor, IDBTransaction];
        }
        return idbProxyableTypes;
    }
    // This is a function to prevent it throwing up in node environments.
    function getCursorAdvanceMethods() {
        if (!cursorAdvanceMethods) {
            cursorAdvanceMethods = [
                IDBCursor.prototype.advance,
                IDBCursor.prototype.continue,
                IDBCursor.prototype.continuePrimaryKey,
            ];
        }
        return cursorAdvanceMethods;
    }
    const cursorRequestMap = new WeakMap();
    const transactionDoneMap = new WeakMap();
    const transformCache = new WeakMap();
    const reverseTransformCache = new WeakMap();
    function promisifyRequest(request) {
        const promise = new Promise((resolve, reject) => {
            const unlisten = () => {
                request.removeEventListener('success', success);
                request.removeEventListener('error', error);
            };
            const success = () => {
                resolve(wrap(request.result));
                unlisten();
            };
            const error = () => {
                reject(request.error);
                unlisten();
            };
            request.addEventListener('success', success);
            request.addEventListener('error', error);
        });
        promise.then((value) => {
            // Since cursoring reuses the IDBRequest (*sigh*), we cache it for later retrieval
            // (see wrapFunction).
            if (value instanceof IDBCursor) {
                cursorRequestMap.set(value, request);
            }
        });
        // This is the only mapping that exists in reverseTransformCache where the reverse doesn't exist
        // in transformCache. This is because we create many promises from a single IDBRequest.
        reverseTransformCache.set(promise, request);
        return promise;
    }
    function cacheDonePromiseForTransaction(tx) {
        // Early bail if we've already created a done promise for this transaction.
        if (transactionDoneMap.has(tx))
            return;
        const done = new Promise((resolve, reject) => {
            const unlisten = () => {
                tx.removeEventListener('complete', complete);
                tx.removeEventListener('error', error);
                tx.removeEventListener('abort', error);
            };
            const complete = () => {
                resolve();
                unlisten();
            };
            const error = () => {
                reject(tx.error);
                unlisten();
            };
            tx.addEventListener('complete', complete);
            tx.addEventListener('error', error);
            tx.addEventListener('abort', error);
        });
        // Cache it for later retrieval.
        transactionDoneMap.set(tx, done);
    }
    let idbProxyTraps = {
        get(target, prop, receiver) {
            if (target instanceof IDBTransaction) {
                // Special handling for transaction.done.
                if (prop === 'done')
                    return transactionDoneMap.get(target);
                // Make tx.store return the only store in the transaction, or undefined if there are many.
                if (prop === 'store') {
                    return target.objectStoreNames[1] ?
                        undefined : receiver.objectStore(target.objectStoreNames[0]);
                }
            }
            // Else transform whatever we get back.
            return wrap(target[prop]);
        },
        has(target, prop) {
            if (target instanceof IDBTransaction && (prop === 'done' || prop === 'store'))
                return true;
            return prop in target;
        },
    };
    function addTraps(callback) {
        idbProxyTraps = callback(idbProxyTraps);
    }
    function wrapFunction(func) {
        // Due to expected object equality (which is enforced by the caching in `wrap`), we
        // only create one new func per func.
        // Cursor methods are special, as the behaviour is a little more different to standard IDB. In
        // IDB, you advance the cursor and wait for a new 'success' on the IDBRequest that gave you the
        // cursor. It's kinda like a promise that can resolve with many values. That doesn't make sense
        // with real promises, so each advance methods returns a new promise for the cursor object, or
        // undefined if the end of the cursor has been reached.
        if (getCursorAdvanceMethods().includes(func)) {
            return function (...args) {
                // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
                // the original object.
                const originalCursor = unwrap(this);
                func.apply(originalCursor, args);
                const request = cursorRequestMap.get(this);
                return wrap(request);
            };
        }
        return function (...args) {
            // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
            // the original object.
            const originalParent = unwrap(this);
            const value = func.apply(originalParent, args);
            return wrap(value);
        };
    }
    function transformCachableValue(value) {
        if (typeof value === 'function')
            return wrapFunction(value);
        // This doesn't return, it just creates a 'done' promise for the transaction,
        // which is later returned for transaction.done (see idbObjectHandler).
        if (value instanceof IDBTransaction)
            cacheDonePromiseForTransaction(value);
        if (instanceOfAny(value, getIdbProxyableTypes()))
            return new Proxy(value, idbProxyTraps);
        // Return the same value back if we're not going to transform it.
        return value;
    }
    function wrap(value) {
        // We sometimes generate multiple promises from a single IDBRequest (eg when cursoring), because
        // IDB is weird and a single IDBRequest can yield many responses, so these can't be cached.
        if (value instanceof IDBRequest)
            return promisifyRequest(value);
        // If we've already transformed this value before, reuse the transformed value.
        // This is faster, but it also provides object equality.
        if (transformCache.has(value))
            return transformCache.get(value);
        const newValue = transformCachableValue(value);
        // Not all types are transformed.
        // These may be primitive types, so they can't be WeakMap keys.
        if (newValue !== value) {
            transformCache.set(value, newValue);
            reverseTransformCache.set(newValue, value);
        }
        return newValue;
    }
    function unwrap(value) {
        return reverseTransformCache.get(value);
    }

    /**
     * Open a database.
     *
     * @param name Name of the database.
     * @param version Schema version.
     * @param callbacks Additional callbacks.
     */
    function openDB(name, version, callbacks = {}) {
        const { blocked, upgrade, blocking } = callbacks;
        const request = indexedDB.open(name, version);
        const openPromise = wrap(request);
        if (upgrade) {
            request.addEventListener('upgradeneeded', (event) => {
                upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction));
            });
        }
        if (blocked)
            request.addEventListener('blocked', () => blocked());
        if (blocking)
            openPromise.then(db => db.addEventListener('versionchange', blocking));
        return openPromise;
    }
    /**
     * Delete a database.
     *
     * @param name Name of the database.
     */
    function deleteDB(name, callbacks = {}) {
        const { blocked } = callbacks;
        const request = indexedDB.deleteDatabase(name);
        if (blocked)
            request.addEventListener('blocked', () => blocked());
        return wrap(request).then(() => undefined);
    }

    function potentialDatabaseExtra(target, prop) {
        return (target instanceof IDBDatabase) &&
            !(prop in target) &&
            typeof prop === 'string';
    }
    const readMethods = ['get', 'getKey', 'getAll', 'getAllKeys', 'count'];
    const writeMethods = ['put', 'add', 'delete', 'clear'];
    // Add index methods
    readMethods.push(...readMethods.map(n => n + 'FromIndex'));
    const cachedMethods = new Map();
    function getMethod(prop) {
        if (readMethods.includes(prop)) {
            return function (storeName, ...args) {
                // Are we dealing with an index method?
                let indexName = '';
                let targetFuncName = prop;
                if (targetFuncName.endsWith('FromIndex')) {
                    indexName = args.shift();
                    targetFuncName = targetFuncName.slice(0, -9); // remove "FromIndex"
                }
                const tx = this.transaction(storeName);
                let target = tx.store;
                if (indexName)
                    target = target.index(indexName);
                return target[targetFuncName](...args);
            };
        }
        if (writeMethods.includes(prop)) {
            return function (storeName, ...args) {
                const tx = this.transaction(storeName, 'readwrite');
                tx.store[prop](...args);
                return tx.done;
            };
        }
    }
    addTraps(oldTraps => ({
        get(target, prop, receiver) {
            // Quick bails
            if (!potentialDatabaseExtra(target, prop)) {
                return oldTraps.get(target, prop, receiver);
            }
            // tslint:disable-next-line:no-parameter-reassignment
            prop = prop;
            const cachedMethod = cachedMethods.get(prop);
            if (cachedMethod)
                return cachedMethod;
            const method = getMethod(prop);
            if (method) {
                cachedMethods.set(prop, method);
                return method;
            }
            return oldTraps.get(target, prop, receiver);
        },
        has(target, prop) {
            return (potentialDatabaseExtra(target, prop) &&
                (readMethods.includes(prop) || writeMethods.includes(prop))) || oldTraps.has(target, prop);
        },
    }));

    const advanceMethodProps = ['continue', 'continuePrimaryKey', 'advance'];
    const methodMap = {};
    const advanceResults = new WeakMap();
    const proxiedCursorToOriginal = new WeakMap();
    const cursorIteratorTraps = {
        get(target, prop) {
            if (!advanceMethodProps.includes(prop))
                return target[prop];
            let cachedFunc = methodMap[prop];
            if (!cachedFunc) {
                cachedFunc = methodMap[prop] = function (...args) {
                    advanceResults.set(this, proxiedCursorToOriginal.get(this)[prop](...args));
                };
            }
            return cachedFunc;
        },
    };
    async function* iterate(...args) {
        // tslint:disable-next-line:no-this-assignment
        let cursor = this;
        if (!(cursor instanceof IDBCursor)) {
            cursor = await cursor.openCursor(...args);
        }
        if (!cursor)
            return;
        cursor = cursor;
        const proxiedCursor = new Proxy(cursor, cursorIteratorTraps);
        proxiedCursorToOriginal.set(proxiedCursor, cursor);
        while (cursor) {
            yield proxiedCursor;
            // If one of the advancing methods was not called, call continue().
            cursor = await (advanceResults.get(proxiedCursor) || cursor.continue());
            advanceResults.delete(proxiedCursor);
        }
    }
    function isIteratorProp(target, prop) {
        return (prop === Symbol.asyncIterator &&
            instanceOfAny(target, [IDBIndex, IDBObjectStore, IDBCursor])) || (prop === 'iterate' &&
            instanceOfAny(target, [IDBIndex, IDBObjectStore]));
    }
    addTraps(oldTraps => ({
        get(target, prop, receiver) {
            if (isIteratorProp(target, prop))
                return iterate;
            return oldTraps.get(target, prop, receiver);
        },
        has(target, prop) {
            return isIteratorProp(target, prop) || oldTraps.has(target, prop);
        },
    }));

    exports.openDB = openDB;
    exports.deleteDB = deleteDB;
    exports.unwrap = unwrap;
    exports.wrap = wrap;

    return exports;

}({}));
