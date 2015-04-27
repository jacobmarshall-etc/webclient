var mDBact, mDBv = 7, mDB, mSDB, mSDBPromises = [];

/**
 *  @brief Dynamic wrapper around MegaDB which eases handling
 *         indexedDBs whose purpose is storing plain objects
 *         with no indexes and loaded in bulk at startup.
 *
 *  @param [string]   aName      Database name.
 *  @param [mixed]    aOptions   MegaDB Options (optional)
 *  @param [function] aCallback  Callback to invoke when the db
 *                               is ready to use (optional)
 *
 *  @details The schema is created at runtime by calling the function
 *           addSchemaHandler. If there is no callback provided on the
 *           constructor a mBroadcaster event will be dispatched with
 *           the DB name, ie mStorageDB:dbname, when it's ready to use.
 *           The version is automatically handled by computing a
 *           MurmurHash3 for the schema, and increased as it changes.
 *
 *  @example
 *       mStorageDB('myDataBase', function(aError) {
 *           if (aError) throw new Error('Database error');
 *
 *           this.add('myTable', {
 *               name: 'John Doe', age: 49, car: 'Volvo'
 *           }).then(function() {
 *               console.log('Item inserted successfully');
 *           });
 *       }).addSchemaHandler('myTable', 'name', function(results) {
 *           results.forEach(function(who) {
 *               console.debug('Meet ' + who.name);
 *           })
 *       });
 */
function mStorageDB(aName, aOptions, aCallback) {
    if (!(this instanceof mStorageDB)) {
        return new mStorageDB(aName, aOptions, aCallback);
    }
    if (typeof aOptions === 'function') {
        aCallback = aOptions;
        aOptions = undefined;
    }
    this.name     = aName;
    this.options  = aOptions;
    this.handlers = {};
    this.schema   = {};
    mSDBPromises.push(this);
    this.onReadyState = aCallback;
}
mStorageDB.prototype = {
    addSchemaHandler: function mStorageDB_addSchemaHandler(aTable, aKeyPath, aHandler) {
        this.schema[aTable] = {
            key: {
                keyPath: aKeyPath
            }
        };

        this.handlers[aTable] = aHandler;
        return this;
    },

    query: function mStorageDB_query(aCommand, aTable, aData) {
        var promise, error;

        if (this.schema[aTable]) {
            if (d) console.log('msdb query', this.name, aCommand, aTable, aData);

            if (aCommand === 'add') {
                promise = this.db.addOrUpdate(aTable, aData);
            }
            else if (aCommand === 'del') {
                promise = this.db.remove(aTable, aData);
            }
            else {
                error = Error("Unknown command '"+aCommand+"'");
            }
        }
        else {
            error = Error("Unknown table '"+aTable+"' for db " + this.name);
        }

        if (error) {
            promise = new MegaPromise();
            Soon(function __msdb_queryError() {
                promise.reject(error);
            });
        }
        return promise;
    },

    setup: function mStorageDB_setup() {
        this.dbtag  = 'msdb_' + this.name + '_' + u_handle + '_';
        var version = +localStorage[this.dbtag + 'v'] || 0;
        var oldHash = +localStorage[this.dbtag + 'hash'];
        var newHash = MurmurHash3(JSON.stringify(this.schema), 0x9e450134);
        var promise = new MegaPromise(), self = this, db;

        if (oldHash !== newHash) {
            localStorage[this.dbtag + 'v'] = ++version;
            localStorage[this.dbtag + 'hash'] = newHash;
        }

        db = new MegaDB(this.name, u_handle, version, this.schema, this.options);

        db.bind('onDbStateReady', function _onDbStateReady() {
            self.fetch(Object.keys(self.schema))
                .then(function() {
                    __dbNotifyCompletion();
                }, function() {
                    __dbNotifyCompletion(true);
                });
        });

        db.bind('onDbStateFailed', function _onDbStateFailed() {
            if (d) console.error('onDbStateFailed', arguments);
            __dbNotifyCompletion(true);
        });

        function __dbNotifyCompletion(aError) {
            if (aError) {
                self.db = null;
                promise.reject(aError);
            } else {
                promise.resolve();
            }
            if (self.onReadyState) {
                Soon(self.onReadyState.bind(self, aError));
                delete self.onReadyState;
            }
            db.unbind('onDbStateReady').unbind('onDbStateFailed');
            mBroadcaster.sendMessage('mStorageDB:' + self.name, aError);
            promise = newHash = oldHash = version = db = self = undefined;
        }

        this.db = db;
        this.add = this.query.bind(this, 'add');
        this.del = this.query.bind(this, 'del');

        return promise;
    },

    fetch: function mStorageDB_fetch(aTables, aPromise) {
        var t = aTables.shift(), self = this;
        if (d) console.log('msdb fetch', t);

        if (!aPromise) {
            aPromise = new MegaPromise();
        }

        if (t) {
            this.db.query(t)
                .execute()
                .done(function _fetchDone(results) {
                    if (d) console.log('msdb fetch done', t, results);

                    if (results.length) {
                        if (self.handlers[t]) {
                            try {
                                self.handlers[t](results, true);
                            }
                            catch(ex) {
                                if (d) console.error(ex);
                            }
                        }
                        else {
                            console.error('No handler for table', t);
                        }
                    }
                    self.fetch(aTables, aPromise);
                }).fail(function _fetchFail() {
                    if (d) console.log('msdb fetch failed', t);
                    aPromise.reject.apply(aPromise, arguments);
                });
        } else {
            aPromise.resolve();
        }

        return aPromise;
    }
};

mBroadcaster.once('startMega', function __idb_setup() {
    if (!window.indexedDB) {
        window.indexedDB = window.webkitIndexedDB || window.msIndexedDB || window.mozIndexedDB;
    }
    if (!window.IDBKeyRange) {
        window.IDBKeyRange = window.webkitIDBKeyRange || window.msIDBKeyRange;
    }
    if (!window.IDBTransaction) {
        window.IDBTransaction = window.webkitIDBTransaction || window.OIDBTransaction || window.msIDBTransaction;
    }
    if (indexedDB) {
        mDB = 0x7f;
    }
});

mBroadcaster.once('startMega', function __msdb_init() {
    var db = new mStorageDB('msmain');

    db.addSchemaHandler( 'ipc',  'p',  processIPC );
    db.addSchemaHandler( 'opc',  'p',  processOPC );
    db.addSchemaHandler( 'ps',   'p',  processPS  );

    mBroadcaster.once('mStorageDB:' + db.name,
        function __msdb_ready(aError) {
            if (d) console.log('mStorageDB.ready', !aError);
            if (aError) {
                mSDB = db = undefined;
            }
        });

    mBroadcaster.once('mFileManagerDB.done',
        function __msdb_setup(aCallback) {
            var promises = mSDBPromises
                    .map(function(aDBInstance) {
                        return aDBInstance.setup();
                    });
            MegaPromise.allDone(promises).always(
                function __msdb_done() {
                    if (aCallback === getsc) {
                        getsc(1);
                    } else {
                        aCallback();
                    }
                    mBroadcaster.sendMessage('mStorageDB!ready');
                });
            mSDBPromises = undefined;
        });

    mBroadcaster.addListener('mFileManagerDB.state',
        function __msdb_state(aState) {
            if (aState === mFileManagerDB.STATE_READONLY) {
                mSDB = undefined;
            } else {
                mSDB = db;
            }
        });
});

var mFileManagerDB = {
    schema: {
        ok: { key: { keyPath: "h"   }},
        s:  { key: { keyPath: "h_u" }},
        u:  { key: { keyPath: "u"   }},
        f:  { key: { keyPath: "h"   }}
    },
    version: 1,

    init: function mFileManagerDB_init() {
        var db = new MegaDB("fm", u_handle, this.version, this.schema, {plugins: {}});

        if (mBroadcaster.crossTab.master) {
            db.bind('onDbStateReady', function _onDbStateReady() {
                if (d) console.log('onDbStateReady', arguments);

                var oldVersion = +localStorage['fmdbv_' + u_handle] || this.currentVersion;
                localStorage['fmdbv_' + u_handle] = this.currentVersion;

                if (oldVersion < this.currentVersion) {
                    if (d) console.log('fmdb version change');
                    mFileManagerDB.reload();
                }
                else if (+localStorage['fmdblock_' + u_handle]) {
                    if (d) console.log('fmdb is locked');
                    mFileManagerDB.reload();
                }
                else {
                    mDB = this;
                    if (localStorage[u_handle + '_maxaction']) {
                        if (d) console.time('fmdb');
                        mFileManagerDB.fetch(Object.keys(mFileManagerDB.schema));
                    } else {
                        mFileManagerDB._loadfm(this);
                    }
                }
            });
        }
        else {
            db.bind('onDbStateReady', function _onDbStateReady() {
                if (d) {
                    console.log('onDbStateReady.slave', arguments);
                    console.time('fmdb');
                }
                mFileManagerDB.fetch(Object.keys(mFileManagerDB.schema));
            });
            this.slave = true;
        }

        db.bind('onDbStateFailed', function _onDbStateFailed() {
            if (d) console.error('onDbStateFailed', arguments);
            mFileManagerDB._loadfm();
        });

        this.db = db;
        this.state = this.STATE_WORKING;
    },

    fetch: function mFileManagerDB_fetch(aTables) {
        var t = aTables.shift();
        if (d) console.log('fmdb fetch', t);

        if (t) {
            this.db.query(t)
                .execute()
                .done(function _fetchDone(results) {
                    if (d) console.log('fmdb fetch done', t, results);

                    if (!results.length) {
                        mFileManagerDB.fetch(aTables);
                    }
                    else if (t === 'f') {
                        for (var i in results) {
                            if (results[i].sk) {
                                var n = results[i];
                                u_sharekeys[n.h] = crypto_process_sharekey(n.h, n.sk);
                            }
                        }
                        $.mDBIgnoreDB = true;
                        process_f(results, function(hasMissingKeys) {
                            delete $.mDBIgnoreDB;
                            if (hasMissingKeys) {
                                mFileManagerDB.reload();
                            } else {
                                mFileManagerDB.fetch(aTables);
                            }
                        }, 1);
                    }
                    else {
                        if (t === 'ok') {
                            process_ok(results, 1);
                        }
                        else if (t === 'u') {
                            for (var i in results) {
                                M.addUser(results[i], 1);
                            }
                        }
                        else if (t === 's') {
                            for (var i in results) {
                                M.nodeShare(results[i].h, results[i], 1);
                            }
                        }
                        else {
                            console.error('Unknown table', t);
                        }
                        mFileManagerDB.fetch(aTables);
                    }
                }).fail(function _fetchFail() {
                    if (d) console.log('fmdb fetch failed', t);

                    if (mFileManagerDB.slave) {
                        mFileManagerDB._loadfm();
                    } else {
                        mFileManagerDB._restart();
                    }
                });
        }
        else {
            var hasEntries = false;
            maxaction = localStorage[u_handle + '_maxaction'];

            for (var i in M.d) {
                hasEntries = true;
                break;
            }

            if (d) {
                console.timeEnd('fmdb');
                console.log('fmdb fetch completed', maxaction, hasEntries);
            }

            if (!maxaction || !hasEntries) {
                if (this.slave) {
                    this._loadfm();
                } else {
                    this.reload();
                }
            }
            else {
                this._setstate(this.db);
                mBroadcaster.sendMessage('mFileManagerDB.done', getsc);
            }
        }
    },

    query: function mFileManagerDB_query(aCommand, aTable, aData) {
        if (this.schema[aTable]) {
            var l = (+localStorage['fmdblock_' + u_handle] | 0) + 1;
            localStorage['fmdblock_' + u_handle] = l;

            if (d) console.log('fmdb query', aCommand, aTable, aData, l);

            var promise;
            if (aCommand === 'add') {
                promise = this.db.addOrUpdate(aTable, aData);
            } else {
                promise = this.db.remove(aTable, aData);
            }

            promise.then(function() {
                var l = (+localStorage['fmdblock_' + u_handle] | 0) - 1;
                localStorage['fmdblock_' + u_handle] = l;
                if (d) console.log('fmdb lock', l);
            });
        } else {
            throw new Error('Unknown fmdb table: ' + aTable);
        }
    },

    reload: function mFileManagerDB_reload() {
        if (this.db) {
            this.db.drop()
                .done(function _dropDone() {
                    if (d) console.log('fmdb dropped');
                    mFileManagerDB._restart();
                }).fail(function _dropFail() {
                    if (d) console.log('fmdb drop failed');
                    mFileManagerDB._loadfm();
                });
            delete this.db;
        } else {
            mFileManagerDB._restart();
        }
    },

    _restart: function mFileManagerDB__restart() {
        delete localStorage['fmdblock_' + u_handle];
        delete localStorage[u_handle + '_maxaction'];
        this.init();
    },

    _loadfm: function mFileManagerDB__loadfm(aDBInstance) {
        this._setstate(aDBInstance);
        mBroadcaster.sendMessage('mFileManagerDB.done', loadfm) || loadfm();
    },

    _setstate: function mFileManagerDB__setstate(aDBInstance) {
        if (!aDBInstance) {
            this.state = this.STATE_FAILED;
            mDB = undefined;
        }
        else if (!mBroadcaster.crossTab.master) {
            if (d) console.log('existing mDB session, read-only mode.');
            this.state = this.STATE_READONLY;
            mDB = undefined;
        }
        else {
            this.state = this.STATE_READY;
            mDB = aDBInstance;
        }
        mBroadcaster.sendMessage('mFileManagerDB.state', this.state);
    },

    state: 0,
    STATE_WAITING:  0,
    STATE_WORKING:  1,
    STATE_READONLY: 2,
    STATE_READY:    4,
    STATE_FAILED:   8
};

function mDBstart(aSlave) {
    switch(mFileManagerDB.state) {
        case mFileManagerDB.STATE_READONLY:
            if (aSlave) {
                mFileManagerDB.
                    _setstate(mFileManagerDB.db);
            }
            break;
        case mFileManagerDB.STATE_WAITING:
            mFileManagerDB.init();
        case mFileManagerDB.STATE_WORKING:
            if (!aSlave && is_fm()) {
                loadingDialog.show();
            }
            break;
        case mFileManagerDB.STATE_FAILED:
            if (!aSlave) {
                loadfm();
            }
        default:
            if (d) console.log('fmdb state', mFileManagerDB.state);
    }
}

function mDBadd(t, n) {
    var a = n;
    if (a.name && a.p !== 'contacts') {
        delete a.name;
    }
    if (a.ar && a.p !== 'contacts') {
        delete a.ar;
    }
    delete a.key;
    delete a.seen;
    // mFileManagerDB.query('add', t, a);
    if (!mFileManagerDB.addQueue) {
        mFileManagerDB.addQueue = {};
    }
    if (!mFileManagerDB.addQueue[t]) {
        mFileManagerDB.addQueue[t] = [];
    }
    mFileManagerDB.addQueue[t].push(a);
    if (mFileManagerDB.addQueueTimer) {
        clearTimeout(mFileManagerDB.addQueueTimer);
    }
    mFileManagerDB.addQueueTimer = setTimeout(function() {
        for (var t in mFileManagerDB.addQueue) {
            var q = mFileManagerDB.addQueue[t];
            mFileManagerDB.query('add', t, q);
        }
        delete mFileManagerDB.addQueue;
        delete mFileManagerDB.addQueueTimer;
    }, 300);
}

function mDBdel(t, id) {
    mFileManagerDB.query('remove', t, id);
}

function mDBreload() {
    loadfm.loaded = false;
    mFileManagerDB.reload();
}

function mDBcls() {
    if (typeof mDB === 'object' && mDB.close) {
        mDB.close();
    }
    mDB = indexedDB ? 0x9e : undefined;
}
