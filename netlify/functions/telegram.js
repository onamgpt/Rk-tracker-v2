const https = require("https");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return {statusCode:200, headers:h, body:""};

  const BOT = "8852628858:AAHAZ3ZjosHPrEC0OU8fDnRXBNcKnwO2gus";
  const CHAT = "8632288596";

  try {
    var body = JSON.parse(event.body || "{}");
    var msg = body.message || "";
    if (!msg) return {statusCode:400, headers:h, body:JSON.stringify({error:"no message"})};

    var payload = JSON.stringify({chat_id:CHAT, text:msg, parse_mode:"HTML"});
    var result = await new Promise(function(resolve, reject) {
      var req = https.request({
        hostname:"api.telegram.org",
        path:"/bot"+BOT+"/sendMessage",
        method:"POST",
        headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload)}
      }, function(res){
        var data="";
        res.on("data", function(c){data+=c;});
        res.on("end", function(){resolve(data);});
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    return {statusCode:200, headers:h, body:result};
  } catch(e) {
    return {statusCode:500, headers:h, body:JSON.stringify({error:e.message})};
  }
};
