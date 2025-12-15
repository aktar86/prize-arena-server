const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 4000;
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const serviceAccount = require("./prize-arena-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

//----------------Tracking Id
const crypto = require("crypto");

function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix

  // YYYYMMDD format
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // 6-character random HEX
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(cors());
app.use(express.json()); //for converting stringify to object

//verify fire base token
const verifyFireBaseToken = async (req, res, next) => {
  console.log("Headers aktar: ", req.headers);

  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log(decoded);
  } catch {
    return res.status(401).send({ message: "unauthorized access" });
  }
  next();
};

const uri = process.env.PA_MONGO_URI;

// Create a MongoClient
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const run = async () => {
  try {
    await client.connect();

    const db = client.db("prize_arena_DB");
    const usersCollection = db.collection("users");
    const creatorsCollection = db.collection("creators");
    const contestCollection = db.collection("contests");
    const paymentCollection = db.collection("payments");
    const participationCollection = db.collection("participation");

    //users related api
    app.get("/users", async (req, res) => {
      const cursor = usersCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    //for useRole hook api
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      // res.send(result); //need to understand here
    });

    app.patch("/users/:id/role", async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: roleInfo.role,
        },
      };

      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createAt = new Date();

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //creator related api
    app.get("/creators", verifyFireBaseToken, async (req, res) => {
      const cursor = creatorsCollection.find().sort({ createAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch("/creators/:id", async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
        },
      };

      const result = await creatorsCollection.updateOne(query, updateDoc);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "creator",
          },
        };

        const result = await usersCollection.updateOne(userQuery, updateUser);
        console.log("update user:", result);
        // res.send(result);
      }

      res.send(result);
    });

    app.delete("/creators/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await creatorsCollection.deleteOne(query);
      res.send(result);
    });

    app.post("/creators", async (req, res) => {
      const creator = req.body;
      creator.status = "pending";
      creator.createAt = new Date();
      const email = creator.creatorEmail;

      const existingCreator = await creatorsCollection.findOne({
        creatorEmail: email,
      });
      if (existingCreator) {
        return res.status(404).send({ message: "creator exists" });
      }

      const result = await creatorsCollection.insertOne(creator);
      res.send(result);
    });

    // contest related api
    app.get("/contests", async (req, res) => {
      const { email, status } = req.query;

      let query = {};
      //my contest query
      if (email) {
        query.creatorEmail = email;
      }

      //all contest page confirmed query
      if (status) {
        query.status = status;
      }

      const cursor = contestCollection
        .find(query)
        .sort({ participantsCount: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await contestCollection.findOne(query);

      if (!result) {
        return res.status(404).send({ message: "content not found" });
      }

      res.send(result);
    });

    app.patch("/contests/:id", async (req, res) => {
      const statusInfo = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          status: statusInfo.status,
        },
      };
      console.log(updateDoc);
      const result = await contestCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    app.delete("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await contestCollection.deleteOne(query);
      res.send(result);
    });

    app.post("/contests", async (req, res) => {
      const contest = req.body;
      contest.status = "Pending";
      contest.createAt = new Date();
      contest.participantsCount = 0;
      contest.winner = {
        name: null,
        userId: null,
        declaredAt: null,
      };

      const result = await contestCollection.insertOne(contest);
      res.send(result);
    });

    //payment related api
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.title}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: paymentInfo.email,
        metadata: {
          paymentId: paymentInfo.contestId,
          paymentName: paymentInfo.title,
          userUID: paymentInfo.userUID,
          userEmail: paymentInfo.email,
          upcomingDeadline: paymentInfo.deadline,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
      });

      res.send({ url: session.url });
    });

    //polished by deepseek
    app.patch("/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        // Validate sessionId
        if (!sessionId) {
          return res.status(400).json({
            success: false,
            message: "Session ID is required",
          });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Check if payment is successful
        if (session.payment_status !== "paid") {
          return res.status(400).json({
            success: false,
            message: "Payment not completed",
          });
        }

        // Check existing payment
        const transactionId = session.payment_intent;
        const queryExistingPayment = { transactionId: transactionId };
        const existingPayment = await paymentCollection.findOne(
          queryExistingPayment
        );

        // If payment already exists, return existing data
        if (existingPayment) {
          return res.json({
            success: true,
            message: "Payment already processed",
            trackingId: existingPayment.trackingId,
            transactionId,
            isAlreadyProcessed: true,
          });
        }

        const trackingId = generateTrackingId();
        const contestId = session.metadata.paymentId;

        // Validate contestId
        if (!contestId) {
          return res.status(400).json({
            success: false,
            message: "Contest ID not found",
          });
        }

        const query = { _id: new ObjectId(contestId) };

        // Increment participant count
        const contestUpdate = await contestCollection.updateOne(query, {
          $inc: { participantsCount: 1 },
        });

        if (contestUpdate.modifiedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Contest not found",
          });
        }

        // 2. Save payment info
        const payment = {
          contestId: new ObjectId(contestId),
          contestName: session.metadata.paymentName,
          userUID: session.metadata.userUID,
          userEmail: session.metadata.userEmail,
          amount: session.amount_total / 100,
          currency: session.currency,
          transactionId: transactionId,
          paymentStatus: session.payment_status,
          upcomingDeadline: session.metadata.upcomingDeadline,
          paidAt: new Date(),
          trackingId,
        };

        const paymentResult = await paymentCollection.insertOne(payment);

        // 3. Create participation if not exists
        const alreadyParticipated = await participationCollection.findOne({
          contestId: new ObjectId(contestId),
          userUID: session.metadata.userUID,
        });

        let participationResult = null;
        if (!alreadyParticipated) {
          const participation = {
            contestId: new ObjectId(contestId),
            userUID: session.metadata.userUID,
            userEmail: session.metadata.userEmail,
            paymentStatus: session.payment_status,
            registeredAt: new Date(),
            hasSubmitted: false,
          };
          participationResult = await participationCollection.insertOne(
            participation
          );
        }

        // Final response
        res.json({
          success: true,
          message: "Payment processed successfully",
          trackingId,
          transactionId,
          isAlreadyProcessed: false,
          paymentInfo: {
            insertedId: paymentResult.insertedId,
            contestId: contestId,
            contestName: payment.contestName,
          },
          participationInfo: participationResult
            ? {
                insertedId: participationResult.insertedId,
              }
            : { message: "Already participated" },
        });
      } catch (error) {
        console.error("Payment success error:", error);

        // Handle specific errors
        if (error.type === "StripeInvalidRequestError") {
          return res.status(400).json({
            success: false,
            message: "Invalid session ID",
          });
        }

        res.status(500).json({
          success: false,
          message: "Internal server error",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    //participation related api
    app.get("/participation/:id", async (req, res) => {
      const contestId = req.params.id;
      const { userUID } = req.query;

      if (!userUID) {
        return res.send({ participated: false });
      }

      // participation collection check
      const participation = await participationCollection.findOne({
        contestId: contestId,
        userUID: userUID,
      });

      // payment collection check
      const payment = await paymentCollection.findOne({
        contestId: contestId,
        userUID: userUID,
      });

      if (participation && payment) {
        return res.send({ participated: true });
      }

      res.send({ participated: false });
    });

    //sent a ping to confirm
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // await client.close();
  }
};
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("prize arena server is running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
