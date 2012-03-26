/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- /
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

(function() {

  var debugging = true;
  var debug = function(str) {
    if (!debugging)
      return;

    if (window.dump)
      window.dump('JSZhuyin: ' + str + '\n');
    if (console && console.log) {
      console.log('JSZhuyin: ' + str);
      if (arguments.length > 1)
        console.log.apply(this, arguments);
    }
  };

  /* for non-Mozilla browsers */
  if (!KeyEvent) {
    var KeyEvent = {
      DOM_VK_BACK_SPACE: 0x8,
      DOM_VK_RETURN: 0xd
    };
  }

  var IMEngine = function ime() {
    var settings;

    /*
      Terminologies:

        * Symbol: single Zhuyin alphabet, e.g. "ㄊ"
        * Syllable: a set of symbols that made up a sound e.g. "ㄊㄞˊ",
          it always ended with tone symbol in Zhuyin.
        * Terms: a meaningful series of characters in Chinese,
          e.g. "台北".
          Possible to have one character only, e.g. "台".
        * Sentence: combination of terms.
        * Buffer: Symbols are resolved into syllables and put in the
          buffer for look up terms in database.
        * Candidates: Sentence or terms that resolved from syllables
          for user to select for actual output.

      This "Smart" Zhuyin IME aim to select terms automatically based on
      series of syllables user inputs, so user won't have to choose characters
      to build terms one by one. Still, in order to allow access to all
      characters, every character in our targeted range is included in the
      database as one character term, but with lowest score.

    */

    // Enable IndexedDB
    var enableIndexedDB = true;

    // Tell the algorithm what's the longest term
    // it should attempt to match
    var kDBTermMaxLength = 8;

    // Buffer limit will force output the first matching terms
    // if the length of the syllables buffer is reached.
    // This hides the fact that we are using a 2^n algorithm
    var kBufferLenLimit = 8;

    // The following features require range search
    // disable on low end phones
    // Without these features user can only do
    // ㄊㄞˊㄅㄟˇ -> 台北

    // Incomplete Matching allow user to do this:
    // ㄊㄅ -> 台北
    // But some terms never gets matched in this way, like
    // ㄓㄨ -> 諸, not 中文
    var incompleteMatching = true;

    // Auto-complete allow user to do this:
    // ㄊㄞˊㄅ -> 台北
    var autocompleteLastSyllables = true;

    // Auto-suggest generates candidates that follows a selection
    // ㄊㄞˊㄅㄟˇ -> 台北, then suggest 市, 縣, 市長, 市立 ...
    var autoSuggestCandidates = true;

    /* ==== init functions ==== */

    var db;

    var initDB = function ime_initDB(readyCallback) {
      var dbSettings = {
        wordsJSON: settings.path + '/words.json',
        phrasesJSON: settings.path + '/phrases.json',
        enableIndexedDB: enableIndexedDB
      };

      if (readyCallback)
        dbSettings.ready = readyCallback;

      db = new IMEngineDatabase();
      db.init(dbSettings);
    }

    /* ==== helper functions ==== */

    var syllablesInBuffer = [''];
    var pendingSymbols = ['', '', '', ''];
    var firstCandidate = '';

    var SymbolType = {
      CONSTANT: 0,
      VOWEL1: 1,
      VOWEL2: 2,
      TONE: 3
    };

    var typeOfSymbol = function ime_typeOfSymbol(code) {

      var tones = [' ', '˙', 'ˊ', 'ˇ', 'ˋ'];

      /* ㄅ - ㄙ */
      if (code >= 0x3105 && code <= 0x3119)
        return SymbolType.CONSTANT;
      /* ㄧㄨㄩ */
      if (code >= 0x3127 && code <= 0x3129)
        return SymbolType.VOWEL1;
      /* ㄚ - ㄦ */
      if (code >= 0x311A && code <= 0x3126)
        return SymbolType.VOWEL2;
      /*  ˙ˊˇˋ */
      if (tones.indexOf(String.fromCharCode(code)) !== -1)
        return SymbolType.TONE;

      return false;
    };

    var sendPandingSymbols = function ime_updatePandingSymbol() {
      var symbols = syllablesInBuffer.join('').replace(/\*/g, '');
      settings.sendPandingSymbols(symbols);
    };

    var empty = function ime_empty() {
      debug('Empty buffer.');
      syllablesInBuffer = [''];
      pendingSymbols = ['', '', '', ''];
      firstCandidate = '';
      sendPandingSymbols();
      isWorking = false;
      if (!db)
        initDB();
    };

    var lookup = function ime_lookup(query, type, callback) {
      switch (type) {
        case 'sentence':
          db.getSentences(query, function getSentencesCallback(dbResults) {
            if (!dbResults) {
              callback([]);
              return;
            }
            var results = [];
            dbResults.forEach(function readSentence(sentence) {
              var str = '';
              sentence.forEach(function readTerm(term) {
                str += term[0];
              });
              if (results.indexOf(str) === -1)
                results.push(str);
            });
            callback(results);
          });
        break;
        case 'term':
          db.getTerms(query, function getTermsCallback(dbResults) {
            if (!dbResults) {
              callback([]);
              return;
            }
            var results = [];
            dbResults.forEach(function readTerm(term) {
              results.push(term[0]);
            });
            callback(results);
          });
        break;
        case 'suggestion':
          db.getSuggestions(
            query[0], query[1],
            function gotSuggestions(dbResults) {
              if (!dbResults) {
                callback([]);
                return;
              }
              var results = [];
              dbResults.forEach(function readTerm(term) {
                results.push(term[0]);
              });
              callback(results);
            }
          );
        break;
        default:
          debug('Error: no such lookup() type.');
        break;
      }
    };

    var updateCandidateList =
      function ime_updateCandidateList(callback, noSuggestions) {
      debug('Update Candidate List.');

      if (!syllablesInBuffer.join('').length) {
        if (autoSuggestCandidates &&
            selectedText &&
            !noSuggestions) {
          debug('Buffer is empty; ' +
            'make suggestions based on select term.');
          var candidates = [];
          var texts = selectedText.split('');
          var i = syllablesRemoved.length;
          lookup([syllablesRemoved, texts], 'suggestion',
            function(suggestions) {
              selectedText = undefined;
              syllablesRemoved = undefined;
              suggestions.forEach(
                function suggestions_forEach(suggestion) {
                  candidates.push(
                    [suggestion.substr(texts.length), 'suggestion']);
                }
              );
              if (candidates.length) {
                settings.sendCandidates(candidates);
                firstCandidate = candidates[0][0];
              } else {
                settings.sendCandidates([]);
                firstCandidate = '';
              }
              callback();
            }
          );
          return;
        }
        debug('Buffer is empty; send empty candidate list.');
        settings.sendCandidates([]);
        firstCandidate = '';
        callback();
        return;
      }

      var candidates = [];
      var syllablesForQuery = [].concat(syllablesInBuffer);

      if (!pendingSymbols[SymbolType.TONE] &&
          syllablesForQuery[syllablesForQuery.length - 1]) {
        if (autocompleteLastSyllables) {
          debug('The last syllable is incomplete, add asterisk.');
          syllablesForQuery[syllablesForQuery.length - 1] =
            pendingSymbols.join('') + '*';
        } else {
          debug('The last syllable is incomplete, add default tone.');
          syllablesForQuery[syllablesForQuery.length - 1] =
           pendingSymbols.join('') + ' ';
        }
      }

      if (!syllablesForQuery[syllablesForQuery.length - 1]) {
        syllablesForQuery.pop();
      }

      debug('Get term candidates for the entire buffer.');
      lookup(syllablesForQuery, 'term', function lookupCallback(terms) {
        terms.forEach(function readTerm(term) {
          candidates.push([term, 'whole']);
        });

        if (syllablesInBuffer.length === 1) {
          debug('Only one syllable; skip other lookups.');

          if (!candidates.length) {
            // candidates unavailable; output symbols
            candidates.push([syllablesInBuffer.join(''), 'whole']);
          }

          settings.sendCandidates(candidates);
          firstCandidate = candidates[0][0];
          callback();
          return;
        }

        debug('Lookup for sentences that make up from the entire buffer');
        var syllables = syllablesForQuery;
        lookup(syllables, 'sentence', function lookupCallback(sentences) {
          sentences.forEach(function readSentence(sentence) {
            // look for candidate that is already in the list
            var exists = candidates.some(function sentenceExists(candidate) {
              return (candidate[0] === sentence);
            });

            if (exists)
              return;

            candidates.push([sentence, 'whole']);
          });

          firstCandidate = candidates[0][0];

          // The remaining candidates doesn't match the entire buffer
          // these candidates helps user find the exact character/term
          // s/he wants
          // The remaining unmatched syllables will go through lookup
          // over and over until the buffer is emptied.

          var i = Math.min(kDBTermMaxLength, syllablesInBuffer.length - 1);

          var findTerms = function lookupFindTerms() {
            debug('Lookup for terms that matches first ' + i + ' syllables.');

            var syllables = syllablesForQuery.slice(0, i);

            lookup(syllables, 'term', function lookupCallback(terms) {
              terms.forEach(function readTerm(term) {
                candidates.push([term, 'term']);
              });

              if (i === 1 && !terms.length) {
                debug('The first syllable does not make up a word,' +
                  ' output the symbol.');
                candidates.push(
                  [syllables.join('').replace(/\*/g, ''), 'symbol']);
              }

              if (!--i) {
                debug('Done Looking.');
                settings.sendCandidates(candidates);
                callback();
                return;
              }

              findTerms();
              return;
            });
          };

          findTerms();
        });
      });


    };

    /* ==== the keyQueue loop === */

    var keypressQueue = [];
    var isWorking = false;

    var start = function ime_start() {
      if (isWorking)
        return;
      isWorking = true;
      debug('Start keyQueue loop.');
      next();
    };

    var next = function ime_next() {
      debug('Processing keypress');

      if (!db) {
        debug('DB not initialized, defer processing.');
        initDB(next);
        return;
      }
      if (!keypressQueue.length) {
        debug('keyQueue emptied.');
        isWorking = false;
        return;
      }

      var code = keypressQueue.shift();

      if (code == 0) {
        // This is a select function operation after selecting suggestions
        sendPandingSymbols();
        updateCandidateList(next, true);
        return;
      }

      if (code < 0) {
        // This is a select function operation
        var i = code * -1;
        dump('Removing ' + (code * -1) + ' syllables from buffer.');

        syllablesRemoved = syllablesInBuffer.slice(0, i);

        while (i--) {
          syllablesInBuffer.shift();
        }

        if (!syllablesInBuffer.length) {
          syllablesInBuffer = [''];
          pendingSymbols = ['', '', '', ''];
        }

        sendPandingSymbols();
        updateCandidateList(next);
        return;
      }

      debug('key code: ' + code);

      if (code === KeyEvent.DOM_VK_RETURN) {
        debug('Return Key');
        if (!firstCandidate) {
          debug('Default action.');
          // pass the key to IMEManager for default action
          settings.sendKey(code);
          next();
          return;
        }

        // candidate list exists; output the first candidate
        debug('Sending first candidate.');
        settings.sendString(firstCandidate);
        settings.sendCandidates([]);
        empty();
        next();
        return;
      }

      if (code === KeyEvent.DOM_VK_BACK_SPACE) {
        debug('Backspace key');
        if (!syllablesInBuffer.join('') &&
            !firstCandidate) {
          // pass the key to IMEManager for default action
          debug('Default action.');
          settings.sendKey(code);
          next();
          return;
        }

        if (!syllablesInBuffer.join('')) {
          debug('Remove candidates.');
          updateCandidateList(next);
          return;
        }

        if (!pendingSymbols.join('')) {
          // pendingSymbols is empty
          // remove the last symbol in the last syllable in buffer
          debug('Remove last syllable.');
          syllablesInBuffer.pop();
          // XXX: we do this here instead of changing _entire_ code
          // on definition of syllablesInBuffer.
          pendingSymbols = (function pendingSymbols_unjoin(syllable) {
            var symbols = ['', '', '', ''];
            syllable.split('').forEach(
              function syllable_forEach(symbol) {
                var type = typeOfSymbol(symbol.charCodeAt(0));
                if (type !== false)
                  symbols[type] = symbol;
              }
            );
            return symbols;
          })(syllablesInBuffer[syllablesInBuffer.length - 1]);
        }

        debug('Remove one pending symbols.');

        var i = 4;
        while (i--) {
          if (pendingSymbols[i] == '*' || pendingSymbols[i] == '')
            continue;
          pendingSymbols[i] = '';
          break;
        }

        syllablesInBuffer[syllablesInBuffer.length - 1] =
          pendingSymbols.join('');
        sendPandingSymbols();
        updateCandidateList(next);
        return;
      }

      var type = typeOfSymbol(code);

      if (type === false) {
        debug('Non-bopomofo code');

        if (firstCandidate) {
          // candidate list exists; output the first candidate
          debug('Sending first candidate.');
          settings.sendString(firstCandidate);
          settings.sendCandidates([]);
          empty();

          // no return here
        }

        //pass the key to IMEManager for default action
        debug('Default action.');
        settings.sendKey(code);
        next();
        return;
      }

      var symbol = String.fromCharCode(code);

      debug('Processing symbol: ' + symbol);

      // add symbol to pendingSymbols
      if (incompleteMatching &&
          pendingSymbols.slice(type).join('') !== '') {
        debug('Symbol place already occupied; move on to next.');
        pendingSymbols[SymbolType.TONE] = '*';
        syllablesInBuffer[syllablesInBuffer.length - 1] =
          pendingSymbols.join('');
        syllablesInBuffer.push('');
        pendingSymbols = ['', '', '', ''];
      }
      pendingSymbols[type] = symbol;

      // update syllablesInBuffer
      syllablesInBuffer[syllablesInBuffer.length - 1] =
        pendingSymbols.join('');
      sendPandingSymbols();

      if (kBufferLenLimit &&
        syllablesInBuffer.length >= kBufferLenLimit) {
        // syllablesInBuffer is too long; find a term and sendString()
        debug('Buffer exceed limit');
        var i = syllablesInBuffer.length - 1;

        var findTerms = function ime_findTerms() {
          debug('Find term for first ' + i + ' syllables.');

          var syllables = syllablesInBuffer.slice(0, i);
          lookup(syllables, 'term', function lookupCallback(candidates) {
            if (i !== 1 && !candidates[0]) {
              // not found, keep looking
              i--;
              findTerms();
              return;
            }

            debug('Found.');

            // sendString
            settings.sendString(
              candidates[0] ||
              syllablesInBuffer.slice(0, i).join('').replace(/\*/g, '')
            );

            // remove syllables from buffer
            while (i--) {
              syllablesInBuffer.shift();
            }

            sendPandingSymbols();

            updateCandidateList(next);
          });
        };

        findTerms();
        return;
      }

      updateCandidateList(function updateCandidateListCallback() {
        if (typeOfSymbol(code) === SymbolType.TONE) {
          // bump the buffer to the next character
          syllablesInBuffer.push('');
          pendingSymbols = ['', '', '', ''];
        }

        next();
      });
    };

    /* ==== init ==== */

    this.init = function ime_init(options) {
      debug('Init.');
      settings = options;
    };

    /* ==== uninit ==== */

    this.uninit = function ime_uninit() {
      debug('Uninit.');
      empty();
      db.uninit();
      db = null;
    };

    /* ==== interaction functions ==== */

    this.click = function ime_click(code) {
      if (code <= 0) {
        debug('Ignoring keyCode <= 0.');
        return;
      }
      debug('Click keyCode: ' + code);
      keypressQueue.push(code);
      start();
    };

    var selectedText;
    var syllablesRemoved;

    this.select = function ime_select(text, type) {
      debug('Select text ' + text);
      selectedText = text;
      settings.sendString(text);

      var numOfSyllablesToRemove = text.length;
      if (type == 'symbol')
        numOfSyllablesToRemove = 1;
      if (type == 'suggestion')
        numOfSyllablesToRemove = 0;

      keypressQueue.push(numOfSyllablesToRemove * -1);
      start();
    };

    this.empty = empty;
  };

  var IMEngineDatabase = function imedb() {
    var settings;

    /* name and version of IndexedDB */
    var kDBName = 'JSZhuyin';
    var kDBVersion = 2;

    var jsonData;
    var iDB;

    var iDBCache = {};
    var cacheTimer;
    var kCacheTimeout = 10000;

    var self = this;

    var indexedDB = window.indexedDB ||
      window.webkitIndexedDB ||
      window.mozIndexedDB ||
      window.msIndexedDB;

    var IDBDatabase = window.IDBDatabase ||
      window.webkitIDBDatabase ||
      window.msIDBDatabase;

    var IDBTransaction = window.IDBTransaction ||
      window.webkitIDBTransaction ||
      window.msIDBTransaction;

    var IDBKeyRange = window.IDBKeyRange ||
      window.webkitIDBKeyRange ||
      window.msIDBKeyRange;

    var IDBIndex = window.IDBIndex ||
      window.webkitIDBIndex ||
      window.msIDBIndex;

    /* ==== init functions ==== */

    var getTermsInDB = function imedb_getTermsInDB(callback) {
      if (!indexedDB || // No IndexedDB API implementation
          IDBDatabase.prototype.setVersion || // old version of IndexedDB API
          window.location.protocol === 'file:') {  // bug 643318
        debug('IndexedDB is not available on this platform.');
        callback();
        return;
      }

      var req = indexedDB.open(kDBName, kDBVersion);
      req.onerror = function dbopenError(ev) {
        debug('Encounter error while opening IndexedDB.');
        callback();
      };

      req.onupgradeneeded = function dbopenUpgradeneeded(ev) {
        debug('IndexedDB upgradeneeded.');
        iDB = ev.target.result;

        // delete the old ObjectStore if present
        if (iDB.objectStoreNames.length !== 0)
          iDB.deleteObjectStore('terms');

        // create ObjectStore
        var store = iDB.createObjectStore('terms', { keyPath: 'syllables' });
        store.createIndex(
          'constantSyllables', 'constantSyllables', { unique: false });

        // no callback() here
        // onupgradeneeded will follow by onsuccess event
        return;
      };

      req.onsuccess = function dbopenSuccess(ev) {
        debug('IndexedDB opened.');
        iDB = ev.target.result;
        callback();
      };
    };

    var populateDBFromJSON = function imedbPopulateDBFromJSON(callback) {
      var chunks = [];
      var chunk = [];
      var i = 0;

      for (var syllables in jsonData) {
        chunk.push(syllables);
        i++;
        if (i > 2048) {
          chunks.push(chunk);
          chunk = [];
          i = 0;
        }
      }
      chunks.push(chunk);
      chunks.push(['_last_entry_']);
      jsonData['_last_entry_'] = true;

      var addChunk = function imedbAddChunk() {
        debug('Loading data chunk into IndexedDB, ' +
            (chunks.length - 1) + ' chunks remaining.');

        var transaction = iDB.transaction('terms', IDBTransaction.READ_WRITE);
        var store = transaction.objectStore('terms');

        transaction.onerror = function putError(ev) {
          debug('Problem while populating DB with JSON data.');
        };

        transaction.oncomplete = function putComplete() {
          if (chunks.length) {
            setTimeout(addChunk, 0);
          } else {
            jsonData = null;
            setTimeout(callback, 0);
          }
        };

        var syllables;
        var chunk = chunks.shift();
        for (i in chunk) {
          var syllables = chunk[i];
          var constantSyllables = syllables.replace(/([^\-])[^\-]*/g, '$1');
          store.put({
            syllables: syllables,
            constantSyllables: constantSyllables,
            terms: jsonData[syllables]
          });
        }
      };

      setTimeout(addChunk, 0);
    };

    var getTermsJSON = function imedb_getTermsJSON(callback) {
      getWordsJSON(function getWordsJSONCallback() {
        getPhrasesJSON(callback);
      });
    };

    var getWordsJSON = function imedb_getWordsJSON(callback) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', (settings.wordsJSON || './words.json'), true);
      try {
        xhr.responseType = 'json';
      } catch (e) { }
      xhr.overrideMimeType('application/json; charset=utf-8');
      xhr.onreadystatechange = function xhrReadystatechange(ev) {
        if (xhr.readyState !== 4)
          return;

        var response;
        if (xhr.responseType == 'json') {
          response = xhr.response;
        } else {
          try {
            response = JSON.parse(xhr.responseText);
          } catch (e) { }
        }

        if (typeof response !== 'object') {
          debug('Failed to load words.json: Malformed JSON');
          callback();
          return;
        }

        jsonData = {};
        // clone everything under response coz it's readonly.
        for (var s in response) {
          jsonData[s] = response[s];
        }
        xhr = null;

        callback();
      };

      xhr.send(null);
    };

    var getPhrasesJSON = function getPhrasesJSON(callback) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', (settings.phrasesJSON || './phrases.json'), true);
      try {
        xhr.responseType = 'json';
      } catch (e) { }
      xhr.overrideMimeType('application/json; charset=utf-8');
      xhr.onreadystatechange = function xhrReadystatechange(ev) {
        if (xhr.readyState !== 4)
          return;

        var response;
        if (xhr.responseType == 'json') {
          response = xhr.response;
        } else {
          try {
            response = JSON.parse(xhr.responseText);
          } catch (e) { }
        }

        if (typeof response !== 'object') {
          debug('Failed to load phrases.json: Malformed JSON');
          callback();
          return;
        }

        // clone everything under response coz it's readonly.
        for (var s in response) {
          jsonData[s] = response[s];
        }
        xhr = null;

        callback();
      };

      xhr.send(null);
    };

    /* ==== helper functions ==== */

    /*
    * Math function that return all possible compositions of
    * a given natural number
    * callback will be called 2^(n-1) times.
    *
    * ref: http://en.wikipedia.org/wiki/Composition_(number_theory)#Examples
    * also: http://stackoverflow.com/questions/8375439
    *
    */
    var compositionsOf = function imedb_compositionsOf(n, callback) {
      var x, a, j;
      x = 1 << n - 1;
      while (x--) {
        a = [1];
        j = 0;
        while (n - 1 > j) {
          if (x & (1 << j)) {
            a[a.length - 1]++;
          } else {
            a.push(1);
          }
          j++;
        }
        callback.call(this, a);
      }
    };

    /*
    * Data from IndexedDB gets to kept in iDBCache for kCacheTimeout seconds
    */
    var cacheSetTimeout = function imedb_cacheSetTimeout() {
      debug('Set iDBCache timeout.');
      clearTimeout(cacheTimer);
      cacheTimer = setTimeout(function imedb_cacheTimeout() {
        debug('Empty iDBCache.');
        iDBCache = {};
      }, kCacheTimeout);
    };

    var getTermsFromConstantSyllables =
        function imedb_getTermsFromConstantSyllables(constants, callback) {
      debug('Getting terms with constantSyllables: ' + constants);

      if (iDBCache['CONSTANT:' + constants]) {
        debug('Found constantSyllables result in iDBCache.');
        callback(iDBCache['CONSTANT:' + constants]);
        return;
      }

      var store = iDB.transaction('terms', IDBTransaction.READ_ONLY)
        .objectStore('terms');
      if (IDBIndex.prototype.getAll) {
        // Mozilla IndexedDB extension
        var req = store.index('constantSyllables').getAll(
          IDBKeyRange.only(constants));
      } else {
        var req = store.index('constantSyllables').openCursor(
          IDBKeyRange.only(constants));
      }
      req.onerror = function getdbError(ev) {
        debug('Database read error.');
        callback(false);
      };
      var constantResult = [];
      req.onsuccess = function getdbSuccess(ev) {
        if (ev.target.result && ev.target.result.constructor == Array) {
          constantResult = ev.target.result;
          cacheSetTimeout();
          iDBCache['CONSTANT:' + constants] = constantResult;
          callback(constantResult);
          return;
        }
        var cursor = ev.target.result;
        if (!cursor) {
          cacheSetTimeout();
          iDBCache['CONSTANT:' + constants] = constantResult;
          callback(constantResult);
          return;
        }
        iDBCache[cursor.value.syllables] = cursor.value.terms;
        constantResult.push(cursor.value);
        cursor.continue();
      };
    };

    /* ==== init ==== */

    this.init = function imedb_init(options) {
      settings = options;

      var ready = function imedbReady() {
        debug('Ready.');
        if (settings.ready)
          settings.ready();
      };

      if (!settings.enableIndexedDB) {
        debug('IndexedDB disabled; Downloading JSON ...');
        getTermsJSON(ready);
        return;
      }

      debug('Probing IndexedDB ...');
      getTermsInDB(function getTermsInDBCallback() {
        if (!iDB) {
          debug('IndexedDB not available; Downloading JSON ...');
          getTermsJSON(ready);
          return;
        }

        var transaction = iDB.transaction('terms');

        var req = transaction.objectStore('terms').get('_last_entry_');
        req.onsuccess = function getdbSuccess(ev) {
          if (ev.target.result !== undefined) {
            ready();
            return;
          }

          debug('IndexedDB is supported but empty; Downloading JSON ...');
          getTermsJSON(function getTermsInDBCallback() {
            if (!jsonData) {
              debug('JSON failed to download.');
              return;
            }

            debug(
              'JSON loaded,' +
              'IME is ready to use while inserting data into db ...'
            );
            ready();
            populateDBFromJSON(function getTermsInDBCallback() {
              debug('IndexedDB ready and switched to indexedDB backend.');
            });
          });
        };
      });
    };

    /* ==== uninit ==== */

    this.uninit = function imedb_uninit() {
      if (iDB)
        iDB.close();
      jsonData = null;
    };

    /* ==== db lookup functions ==== */

    this.getSuggestions =
      function imedb_getSuggestions(syllables, text, callback) {
      if (!jsonData && !iDB) {
        debug('Database not ready.');
        callback(false);
        return;
      }

      var syllablesStr = syllables.join('-').replace(/ /g , '');
      var result = [];
      var matchTerm = function matchTerm(term) {
        if (term[0].substr(0, textStr.length) !== textStr)
          return;
        if (term[0] == textStr)
          return;
        result.push(term);
      };
      var processResult = function processResult(r) {
        r = r.sort(
          function sort_result(a, b) {
            return (b[1] - a[1]);
          }
        );
        var result = [];
        var t = [];
        r.forEach(function(term) {
          if (t.indexOf(term[0]) !== -1) return;
          t.push(term[0]);
          result.push(term);
        });
        return result;
      };
      var matchRegEx;
      if (syllablesStr.indexOf('*') !== -1) {
        matchRegEx = new RegExp(
          '^' + syllablesStr.replace(/\-/g, '\\-')
                .replace(/\*/g, '[^\-]*'));
      }
      var textStr = text.join('');
      var result = [];

      debug('Get suggestion for ' + textStr + '.');

      if (typeof iDBCache['SUGGESTION:' + textStr] !== 'undefined') {
        debug('Found in iDBCache.');
        cacheSetTimeout();
        callback(iDBCache['SUGGESTION:' + textStr]);
        return;
      }

      if (jsonData) {
        debug('Lookup in JSON.');
        // XXX: this is not efficient
        for (var s in jsonData) {
          if (matchRegEx) {
            if (!matchRegEx.exec(s))
              continue;
          } else if (s.substr(0, syllablesStr.length) !== syllablesStr) {
            continue;
          }
          var terms = jsonData[s];
          terms.forEach(matchTerm);
        }
        if (result.length) {
          result = processResult(result);
        } else {
          result = false;
        }
        cacheSetTimeout();
        iDBCache['SUGGESTION:' + textStr] = result;
        callback(result);
        return;
      }

      debug('Lookup in IndexedDB.');

      var findSuggestionsInIDB = function findSuggestionsInIDB() {
        var upperBound = syllablesStr.substr(0, syllablesStr.length - 1) +
          String.fromCharCode(
            syllablesStr.substr(syllablesStr.length - 1).charCodeAt(0) + 1);

        debug('Do IndexedDB range search with lowerBound ' + syllablesStr +
          ' and upperBound ' + upperBound + '.');

        var store = iDB.transaction('terms', IDBTransaction.READ_ONLY)
          .objectStore('terms');
        if (IDBIndex.prototype.getAll) {
          // Mozilla IndexedDB extension
          var req = store.getAll(
            IDBKeyRange.bound(syllablesStr, upperBound, true, true));
        } else {
          var req = store.openCursor(
            IDBKeyRange.bound(syllablesStr, upperBound, true, true));
        }
        req.onerror = function getdbError(ev) {
          debug('Database read error.');
          callback(false);
        };
        var finish = function index_finish() {
          if (result.length) {
            result = processResult(result);
          } else {
            result = false;
          }
          cacheSetTimeout();
          iDBCache['SUGGESTION:' + textStr] = result;
          callback(result);
        };
        req.onsuccess = function getdbSuccess(ev) {
          if (ev.target.result && ev.target.result.constructor == Array) {
            ev.target.result.forEach(function index_forEach(value) {
              value.terms.forEach(matchTerm);
            });
            finish();
            return;
          }
          var cursor = ev.target.result;
          if (!cursor) {
            finish();
            return;
          }
          cursor.value.terms.forEach(matchTerm);
          cursor.continue();
        };
      };

      if (!matchRegEx) {
        findSuggestionsInIDB();
        return;
      }
      debug('Attempt to resolve the complete syllables of ' + textStr +
        ' from ' + syllablesStr + '.');
      var constants = syllablesStr.replace(/([^\-])[^\-]*/g, '$1');
      getTermsFromConstantSyllables(
        constants, function gotTerms(constantResult) {
          if (!constantResult) {
            callback(false);
            return;
          }
          constantResult.some(function(obj) {
            if (!matchRegEx.exec(obj.syllables))
              return false;
            return obj.terms.some(function term_forEach(term) {
              if (term[0] === textStr) {
                debug('Found ' + obj.syllables);
                syllablesStr = obj.syllables;
                return true;
              }
              return false;
            });
          });
          findSuggestionsInIDB();
        }
      );
    },

    this.getTerms = function imedb_getTerms(syllables, callback) {
      if (!jsonData && !iDB) {
        debug('Database not ready.');
        callback(false);
        return;
      }

      var syllablesStr = syllables.join('-').replace(/ /g , '');
      var matchRegEx;
      if (syllablesStr.indexOf('*') !== -1) {
        matchRegEx = new RegExp(
          '^' + syllablesStr.replace(/\-/g, '\\-')
                .replace(/\*/g, '[^\-]*') + '$');
        var processResult = function processResult(r) {
          r = r.sort(
            function sort_result(a, b) {
              return (b[1] - a[1]);
            }
          );
          var result = [];
          var t = [];
          r.forEach(function(term) {
            if (t.indexOf(term[0]) !== -1) return;
            t.push(term[0]);
            result.push(term);
          });
          return result;
        };
      }

      debug('Get terms for ' + syllablesStr + '.');

      if (typeof iDBCache[syllablesStr] !== 'undefined') {
        debug('Found in iDBCache.');
        cacheSetTimeout();
        callback(iDBCache[syllablesStr]);
        return;
      }

      if (jsonData) {
        debug('Lookup in JSON.');
        if (!matchRegEx) {
          callback(jsonData[syllablesStr] || false);
          return;
        }
        debug('Do range search in JSON data.');
        var result = [];
        var dash = /\-/g;
        // XXX: this is not efficient
        for (var s in jsonData) {
          if (!matchRegEx.exec(s))
            continue;
          result = result.concat(jsonData[s]);
        }
        if (result.length) {
          result = processResult(result);
        } else {
          result = false;
        }
        cacheSetTimeout();
        iDBCache[syllablesStr] = result;
        callback(result);
        return;
      }

      debug('Lookup in IndexedDB.');

      if (!matchRegEx) {
        var store = iDB.transaction('terms', IDBTransaction.READ_ONLY)
          .objectStore('terms');
        var req = store.get(syllablesStr);
        req.onerror = function getdbError(ev) {
          debug('Database read error.');
          callback(false);
        };

        req.onsuccess = function getdbSuccess(ev) {
          cacheSetTimeout();

          if (!ev.target.result) {
            iDBCache[syllablesStr] = false;
            callback(false);
            return;
          }

          iDBCache[syllablesStr] = ev.target.result.terms;
          callback(ev.target.result.terms);
        };
        return;
      }
      debug('Do range search in IndexedDB.');
      var constants = syllablesStr.replace(/([^\-])[^\-]*/g, '$1');
      getTermsFromConstantSyllables(
        constants,
        function gotTerms(constantResult) {
          var result = [];
          if (!constantResult) {
            callback(false);
            return;
          }
          constantResult.forEach(function(obj) {
            if (matchRegEx.exec(obj.syllables))
              result = result.concat(obj.terms);
          });
          if (result.length) {
            result = processResult(result);
          } else {
            result = false;
          }
          cacheSetTimeout();
          iDBCache[syllablesStr] = result;
          callback(result);
        }
      );
    };

    this.getTermWithHighestScore =
    function imedb_getTermWithHighestScore(syllables, callback) {
      self.getTerms(syllables, function getTermsCallback(terms) {
        if (!terms) {
          callback(false);
          return;
        }
        callback(terms[0]);
      });
    }

    this.getSentences = function imedb_getSentences(syllables, callback) {
      var sentences = [];
      var n = 0;

      compositionsOf.call(
        this,
        syllables.length,
        /* This callback will be called 2^(n-1) times */
        function compositionsOfCallback(composition) {
          var str = [];
          var start = 0;
          var i = 0;

          var next = function composition_next() {
            var numOfWord = composition[i];
            if (composition.length === i)
              return finish();
            i++;
            self.getTermWithHighestScore(
              syllables.slice(start, start + numOfWord),
              function getTermWithHighestScoreCallback(term) {
                if (!term && numOfWord > 1)
                  return finish();
                if (!term) {
                  var syllable =
                    syllables.slice(start, start + numOfWord).join('');
                  debug('Syllable ' + syllable +
                    ' does not made up a word, insert symbol.');
                  term = [syllable.replace(/\*/g, ''), -7];
                }

                str.push(term);
                start += numOfWord;
                next();
              }
            );
          };

          var finish = function compositionFinish() {
            // complete; this composition does made up a sentence
            if (start === syllables.length)
              sentences.push(str);

            if (++n === (1 << (syllables.length - 1))) {
              cacheSetTimeout();

              sentences = sentences.sort(function sortSentences(a, b) {
                var scoreA = 0;

                a.forEach(function countScoreA(term) {
                  scoreA += term[1];
                });

                var scoreB = 0;
                b.forEach(function countScoreB(term) {
                  scoreB += term[1];
                });

                return (scoreB - scoreA);
              });

              callback(sentences);
            }
          };

          next();
        }
      );
    };
  };

  var jszhuyin = new IMEngine();

  // Expose JSZhuyin as an AMD module
  if (typeof define === 'function' && define.amd)
    define('jszhuyin', [], function() { return jszhuyin; });

  // Expose to IMEManager if we are in Gaia homescreen
  if (typeof IMEManager !== 'undefined')
    IMEManager.IMEngines.jszhuyin = jszhuyin;

})();