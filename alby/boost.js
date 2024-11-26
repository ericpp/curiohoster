import axios from "axios";
import jwt from "jsonwebtoken";

const { ALBY_JWT } = process.env;

// request an invoice from a user's wallet
const requestInvoice = async (record) => {
  const [username, hostname] = record.destination.split('@');

  // make sure the username and hostname look somewhat normal
  if (!username.match(/^[\w\d-_\.]+/) || !hostname.match(/^[\w\d-_\.]+/)) {
    throw new Error("Bad lightning address");
  }

  // look up lnurlp info from remote hostname
  let lookup = await axios({
    method: "GET",
    url: `https://${hostname}/.well-known/lnurlp/${username}`,
  }).catch((error) => {
    console.log("lnurlp well-known error: ", error.response.data);
    throw error; // Propagate error up to outer catch block
  });

  if (!lookup.data && !lookup.data.callback) {
    throw new Error("No lnurlp callback url found");
  }

  // request invoice from user's wallet
  let result = await axios({
    method: "GET",
    url: lookup.data.callback,
    params: {
      amount: record.amount * 1000,
      comment: record.customRecords[7629169] || "", // dump tlv into comment field
    },
  }).catch((error) => {
    console.log("lnurlp callback error: ", error.response.data);
    throw error; // Propagate error up to outer catch block
  });

  return result.data.pr;
}

// alby provides a convenient lnurl proxy if we don't want to do the above function
const requestProxiedInvoice = async (record) => {
  let result = await axios({
    method: "GET",
    url: "https://api.getalby.com/lnurl/generate-invoice",
    params: {
      ln: record.destination,
      amount: record.amount * 1000,
      comment: record.customRecords[7629169] || "", // dump tlv into comments field
    },
  }).catch((error) => {
    console.log("alby invoice error: ", error.response.data);
    throw error; // Propagate error up to outer catch block
  });

  return result.data.invoice.pr;
}

const boost = async (req, res) => {
  const cookies = req.cookies;
  const alby = cookies.awt ? jwt.verify(cookies.awt, ALBY_JWT) : undefined;
  const body = req.body;

  if (!alby || !body) {
    res.json([]);
    return;
  }

  const sent_boosts = { bolt11: [], keysends: [] }

  // handle bolt11 payments
  const bolt11 = body.filter(item => item.destination.indexOf('@') !== -1); // has @ (e.g. something@host.com)

  for (const split of bolt11) {
    try {
      let invoice = await requestProxiedInvoice(split);

      let resolve = await axios({
        method: "POST",
        url: "https://api.getalby.com/payments/bolt11",
        headers: { Authorization: `Bearer ${alby.access_token}` },
        data: { invoice: invoice },
      }).catch((error) => {
        console.log("bolt11 payment error: ", error.response.data);
        throw error; // Propagate error up to outer catch block
      });

      sent_boosts['bolt11'].push(resolve.data);

    } catch (err) {
      console.log("bolt11 error: " + err);
      res.status(500).json({ message: "Server Error" });
      return;
    }
  }

  // handle keysend payments
  let keysends = body.filter(item => item.destination.indexOf('@') === -1);

  try {
    let resolve = await axios({
      method: "POST",
      url: "https://api.getalby.com/payments/keysend/multi",
      headers: { Authorization: `Bearer ${alby.access_token}` },
      data: { keysends: keysends },
    }).catch((error) => {
      console.log("keysend payment error: ", error.response.data);
      throw error; // Propagate error up to outer catch block
    });

    sent_boosts['keysends'] = resolve.data.keysends;

  } catch (err) {
    console.log("albyauth: " + err);
    res.status(500).json({ message: "Server Error" });
    return;
  }

  res.status(200).json(sent_boosts);
};

export default boost;
