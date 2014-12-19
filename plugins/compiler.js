/**
 Copyright 2014 Gordon Williams (gw@pur3.co.uk)

 This Source Code is subject to the terms of the Mozilla Public
 License, v2.0. If a copy of the MPL was not distributed with this
 file, You can obtain one at http://mozilla.org/MPL/2.0/.
 
 ------------------------------------------------------------------
  An Compiler that converts any bit of JavaScript tagged with
  "compiled" into native code.
  
  function foo(a,b) {
    "compiled";
    return a+b;
  }
 ------------------------------------------------------------------
**/
"use strict";
(function(){
  
  function init() {
    // When code is sent to Espruino, search it for modules and add extra code required to load them 
    Espruino.addProcessor("transformForEspruino", function(code, callback) {
      compileCode(code, callback);
    });
  }
  
  function isFloat(n) {
    return n === +n && n !== (n|0);
  }
  
  function stackValue() {
    return "[stack]";
  }
  
  function isStackValue(x) {
    return x=="[stack]";
  }
  
  var handlers = {
      "BlockStatement" : function(x, node) {
        node.body.forEach(function(s) {
          var v = x.handle(s);
          if (v) x.call("jsvUnLock",v);
        });
      },
      "ReturnStatement" : function(x, node) {
        var v = x.handle(node.argument);
        if (v) x.out("  pop {r0}");
        x.out("  b end_of_fn");
      },  
      "ExpressionStatement" : function(x, node) {
        return x.handle(node.expression);
      },
      "AssignmentExpression" : function(x, node) {
        if (node.operator != "=")
          console.warn("Unhandled AssignmentExpression '"+node.operator+"'");
        var l = x.handle(node.left);
        var r = x.handle(node.right);
        return x.call("jspReplaceWith", l, r);
      },      
      "BinaryExpression" : function(x, node) {
        var l = x.handle(node.left);
        var r = x.handle(node.right);
        return x.call("jsvMathsOp", l, r, node.operator.charCodeAt(0));
      },
      "Literal" : function(x, node) {
        if (typeof node.value == "string")
          return x.call("jsvNewFromString", x.addBinaryData(node.value));
        else if (typeof node.value == "number") {
          if (isFloat(node.value)) 
            return x.call("jsvNewFromFloat", x.addBinaryData(node.value));
          else 
            return x.call("jsvNewFromInteger", x.addBinaryData(node.value));
        } else console.warn("Unknown literal type "+typeof node.value);
      },        
      "Identifier" : function(x, node) {
        var localOffset = x.getLocalOffset(node.name);
        if (localOffset !== undefined) {
          x.out("  ldr r0, [sp,#"+localOffset+"]", "FIXME - need offset");
          x.out("  push {r0}");
          return stackValue();
        } else { 
          // else search for the global variable
          var name = x.addBinaryData(node.name);
          return x.call("jspeiFindInScopes", name);
        }
      }
  };
  
  function compileFunction(node) {
    var locals = {}; // dictionary of local variables
    var params = []; // simple list of the type of each parameter
    var constData = []; // constants that get shoved at the end of the code
    var assembly = []; // assembly that is output
    var x = {    
      "getLocalOffset" : function (name) { // get the offset of the local, or undefined
        if (name in locals) return locals[name].offset;
        return undefined;
      },  
      "handle": function(node) {
        if (node.type in handlers)
          return handlers[node.type](x, node);
        console.warn("No handler for "+node.type);
        console.warn(node);
        return undefined;
      },
      // Store binary data and return a pointer
      "addBinaryData": function(data) {
        // TODO: what if this could have been stored directly in a thumb operation
        // strings need zero terminating
        if (typeof data == "string") data+="\0";
        else if (typeof data == "number") {
          if (isFloat(data)) {
            var b = new ArrayBuffer(8);
            new Float64Array(b)[0] = data;
            data = String.fromCharCode.apply(null,new Uint8Array(b));
          } else {
            var b = new ArrayBuffer(4);
            new Int32Array(b)[0] = data;
            data = String.fromCharCode.apply(null,new Uint8Array(b));
          }
        } else console.warn("Unknown data type "+typeof node.value);
        
        // check for dups, work out offset
        for (var n in constData) {
          if (data == constData[n]) 
            return "const_"+n;
          // add to offset - all needs to be word aligned
        }
        // otherwise add to array
        return "const_"+(constData.push(data)-1);
      },
      "out": function(data, comment) {
        console.log("] "+data + (comment?("\t\t; "+comment):""));
        assembly.push(data);
      },
      "call": function(name /*, ... args ... */) {
        for (var i=0;i<arguments.length-1;i++) {
          var arg = arguments[i+1];
          if (isStackValue(arg))
            x.out("  pop {r"+i+"}");
          else if (typeof arg == "number")
            x.out("  movs r"+i+", #"+arg);
          else 
            x.out("  ldr r"+i+", "+arg);
        }
        x.out("  bl "+name);
        if (name!="jsvUnLock") {
          x.out("  push {r0}");
          return stackValue();
        } else
          return undefined;
      }
    };
    // Parse parameters
    node.params.forEach(function( paramNode, idx) { 
      locals[paramNode.name] = { type : "param", offset : idx };
      x.out("  push {r"+idx+"}", "push params onto stack - TODO: could do this in bulk");
      // TODO: add code to clear up at exit
      params.push("JsVar"); 
    }); 
    // Serialise all statements
    node.body.body.forEach(function(s, idx) {
      if (idx==0) return; // we know this is the 'compiled' string
      var v = x.handle(s);
      if (v) x.call("jsvUnLock",v);
    });  
    x.out("end_of_fn:");  
    node.params.forEach(function( paramNode, idx) { 
      x.out("  pop {r3}", "pop params off the stack - TODO: just add/sub stack ptr"); 
    }); 
    x.out("  bx lr"); 
    // do random labels for now
    x.out("jspeiFindInScopes:");
    x.out("  .word 0xDEAD");
    x.out("jsvNewFromInteger:");
    x.out("  .word 0xDEAD");
    x.out("jsvNewFromFloat:");
    x.out("  .word 0xDEAD");
    x.out("jsvNewFromString:");
    x.out("  .word 0xDEAD");
    x.out("jsvMathsOp:");
    x.out("  .word 0xDEAD");
    // Write out any of the constants
    constData.forEach(function(c,n) {
      x.out("const_"+n+":");
      for (var i=0;i<c.length;i+=4) {
        var word = 
          (c.charCodeAt(i  )) |
          (c.charCodeAt(i+1) << 8) |
          (c.charCodeAt(i+2) << 16) |
          (c.charCodeAt(i+3) << 24);
        x.out("  .word 0x"+word.toString(16),  /*comment*/JSON.stringify(c.substr(i,4)));                
      }
    });
    // now try and assemble it
    //console.log(Espruino.Plugins.Assembler.asm(assembly));
    
    var paramSpec = "JsVar ("+params.join(",")+")";
    // wrap this up into an actual 'E.asm' statement:
    return "var "+node.id.name+" = "+"E.asm(\""+paramSpec+"\",\n  "+assembly.map(JSON.stringify).join(",\n  ")+");";
  }

  function compileCode(code, callback) {
    var offset = 0;
    var ast = acorn.parse(code, { ecmaVersion : 6 });
    ast.body.forEach(function(node) {
      if (node.type=="FunctionDeclaration") {
        if (node.body.type=="BlockStatement" &&
            node.body.body.length>0 &&
            node.body.body[0].type=="ExpressionStatement" &&
            node.body.body[0].expression.type=="Literal" && 
            node.body.body[0].expression.value=="compiled") {
          var asm = compileFunction(node);
          if (asm) {
            asm = asm;
            //console.log(asm);
            //console.log(node);
            code = code.substr(0,node.start+offset) + asm + code.substr(node.end+offset);
            offset += (node.end-node.start) + asm.length; // offset for future code snippets
          }
        }
      }
    });
    //console.log(code);
    callback(code);
  }
  
  Espruino.Plugins.Compiler = {
    init : init,
  };
}());
