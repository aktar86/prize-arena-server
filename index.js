const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 4000;
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const decoded = Buffer.from(
  process.env.FIREBASE_SERVICE_KEY,
  "base64"
).toString("utf8");
const serviceAccount = JSON.parse(decoded);

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
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
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
    // await client.connect();

    const db = client.db("prize_arena_DB");
    const usersCollection = db.collection("users");
    const creatorsCollection = db.collection("creators");
    const contestCollection = db.collection("contests");
    const paymentCollection = db.collection("payments");
    const participationCollection = db.collection("participation");
    const submittedCollection = db.collection("submit_tasks");

    //middle more with database access
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;

      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    //users related api
    app.get("/users", async (req, res) => {
      const cursor = usersCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    //for useRole hook api
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    //verify also admin
    app.patch(
      "/users/:id/role",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { role } = req.body;

        // validation
        if (!role) {
          return res.status(400).send({ message: "Role is required" });
        }

        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: role,
          },
        };

        const result = await usersCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;
      user.role = "user";
      user.createAt = new Date();

      // user exist
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "user exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //creator related api
    app.get("/creators", verifyFireBaseToken, verifyAdmin, async (req, res) => {
      const cursor = creatorsCollection.find().sort({ createAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch(
      "/creators/:id",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
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

          const userUpdateResult = await usersCollection.updateOne(
            userQuery,
            updateUser
          );
          console.log("update user:", userUpdateResult);
          // res.send(result);
        }

        res.send(result);
      }
    );

    app.delete(
      "/creators/:id",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await creatorsCollection.deleteOne(query);

        // 2. Data delete hoyeche kina check kora
        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Creator not found" });
        }

        res.send(result);
      }
    );

    app.post("/creators", verifyFireBaseToken, async (req, res) => {
      const creator = req.body;

      const email = creator.creatorEmail;

      // Email Validation by token
      if (!email) {
        return res.status(400).send({ message: "Creator Email is required" });
      }

      const existingCreator = await creatorsCollection.findOne({
        creatorEmail: email,
      });

      if (existingCreator) {
        return res.status(404).send({ message: "creator exists" });
      }

      creator.status = "pending";
      creator.createAt = new Date();

      const result = await creatorsCollection.insertOne(creator);
      res.status(201).send(result);
    });
    //---------------------------------------------------------------
    // contest related api
    app.get("/contests", async (req, res) => {
      const { email, status, searchText } = req.query;

      let query = {};

      //my contest query
      if (email) {
        query.creatorEmail = email;
        console.log(email);
        // check again with decoded email

        // if (email !== req.decoded_email) {
        //   return res.status(403).send({ message: "forbidden access" });
        // }
      }

      //all contest page confirmed query
      if (status) {
        if (status === "Confirmed") {
          query.status = { $in: ["Confirmed", "Closed"] };
        } else {
          query.status = status;
        }
      }

      // search bar logic fix
      if (searchText) {
        query.$or = [
          { contestTitle: { $regex: searchText, $options: "i" } },
          { contestCategory: { $regex: searchText, $options: "i" } },
        ];
      }

      const cursor = contestCollection
        .find(query)
        .sort({ participantsCount: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    //for popular contest
    app.get("/contests/popular-contests", async (req, res) => {
      const cursor = contestCollection
        .find()
        .sort({ participantsCount: -1 })
        .limit(6);

      const result = await cursor.toArray();
      res.send(result);
    });

    //contest card details page api
    app.get("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await contestCollection.findOne(query);

      if (!result) {
        return res.status(404).send({ message: "content not found" });
      }

      res.send(result);
    });

    //admin use for update contest status
    app.patch(
      "/contests/admin/:id",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
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
      }
    );

    //creator update form
    app.patch("/contests/:id", verifyFireBaseToken, async (req, res) => {
      const updateInfo = req.body;
      const id = req.params.id;

      //if user send any status then it will delete from here
      delete updateInfo.status;
      delete updateInfo._id;

      const query = {
        _id: new ObjectId(id),
        status: "Pending",
        creatorEmail: req.decoded_email,
      };
      const updateDoc = {
        $set: {
          ...updateInfo,
        },
      };

      //array create and length check
      if (Object.keys(updateInfo).length === 0) {
        return res
          .status(400)
          .send({ message: "No valid fields provided for update." });
      }

      const result = await contestCollection.updateOne(query, updateDoc);

      if (result.modifiedCount === 0 && result.matchedCount > 0) {
        return res.status(403).send({
          message:
            "Update failed. The contest is no longer in 'Pending' status and cannot be modified.",
        });
      }
      res.send(result);
    });

    //contest winner api hit by creator
    app.patch(
      "/contest/declare-winner/:id",

      async (req, res) => {
        const { name, email, photoUrl, userUid } = req.body;
        const id = req.params.id;
        const query = {
          _id: new ObjectId(id),
          creatorEmail: req.decoded_email,
          status: { $ne: "Closed" },
        };
        const updateDoc = {
          $set: {
            winner: {
              name,
              email,
              photoUrl,
              userUid,
              declaredAt: new Date(),
            },
            status: "Closed",
          },
        };

        const result = await contestCollection.updateOne(query, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(403).send({
            message:
              "Action forbidden. Either you are not the creator or winner already declared.",
          });
        }
        res.send(result);
      }
    );

    //admin crator both will hit for delete contest
    app.delete("/contests/:id", verifyFireBaseToken, async (req, res) => {
      const id = req.params.id;
      const userEmail = req.decoded_email;

      const user = await usersCollection.findOne({ email: userEmail });
      const isAdmin = user?.role === "admin";

      const query = { _id: new ObjectId(id) };

      if (!isAdmin) {
        query.creatorEmail = userEmail;
      }

      const result = await contestCollection.deleteOne(query);

      if (result.deletedCount === 0) {
        return res.status(403).send({
          message: "Access forbidden or contest not found.",
        });
      }
      res.send(result);
    });

    app.post("/contests", async (req, res) => {
      const contest = req.body;

      contest.creatorEmail = req.decoded_email;

      contest.status = "Pending";
      contest.createAt = new Date();
      contest.participantsCount = 0;
      contest.winner = {
        name: null,
        email: null,
        photoUrl: null,
        declaredAt: null,
      };

      const result = await contestCollection.insertOne(contest);
      res.status(201).send(result);
    });

    //---------------------------------------------------------------------------------------

    //payment related api
    app.post(
      "/create-checkout-session",
      verifyFireBaseToken,
      async (req, res) => {
        const paymentInfo = req.body;
        const userEmail = req.decoded_email;

        const amount = Math.round(parseFloat(paymentInfo.cost) * 100);

        if (isNaN(amount) || amount <= 0) {
          return res.status(400).send({ message: "Invalid payment amount" });
        }

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "USD",
                unit_amount: amount,
                product_data: {
                  name: `Please pay for: ${paymentInfo.title}`,
                  description: "Contest entry fee",
                },
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          customer_email: userEmail,
          metadata: {
            paymentId: paymentInfo.contestId,
            paymentName: paymentInfo.title,
            userUID: paymentInfo.userUID,
            userEmail: userEmail,
            upcomingDeadline: paymentInfo.deadline,
          },
          success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
        });

        res.send({ url: session.url });
      }
    );
    /*
    app.patch("/payment-success", verifyFireBaseToken, async (req, res) => {
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

        const contestId = session.metadata.paymentId;
        const trackingId = generateTrackingId();

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
          contestId: contestId,
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
          contestId: contestId,
          userUID: session.metadata.userUID,
        });

        let participationResult = null;
        if (!alreadyParticipated) {
          const participation = {
            contestId: contestId,
            userUID: session.metadata.userUID,
            contestName: session.metadata.paymentName,
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
        res.send({
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
          return res.status(400).send({
            success: false,
            message: "Invalid session ID",
          });
        }

        res.status(500).send({
          success: false,
          message: "Internal server error",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });
*/

    app.patch("/payment-success", verifyFireBaseToken, async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        // 1. Session ID check
        if (!sessionId) {
          return res
            .status(400)
            .json({ success: false, message: "Session ID is required" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // SECURITY VALIDATION: Token theke pawa email ar session-er email match kora dorkar
        if (session.metadata.userEmail !== req.decoded_email) {
          return res
            .status(403)
            .json({ success: false, message: "Unauthorized: Access Denied" });
        }

        // 2. Payment Status check
        if (session.payment_status !== "paid") {
          return res
            .status(400)
            .json({ success: false, message: "Payment not completed" });
        }

        const transactionId = session.payment_intent;

        // 3. Double Payment Check (Double entry bondho korte)
        const existingPayment = await paymentCollection.findOne({
          transactionId,
        });
        if (existingPayment) {
          return res.json({
            success: true,
            message: "Payment already processed",
            trackingId: existingPayment.trackingId,
            transactionId,
            isAlreadyProcessed: true,
          });
        }

        const contestId = session.metadata.paymentId;
        const trackingId = generateTrackingId();

        // 4. Contest ID validation
        if (!contestId) {
          return res.status(400).json({
            success: false,
            message: "Contest ID not found in metadata",
          });
        }

        const query = { _id: new ObjectId(contestId) };

        //  5. Increment participant count
        const contestUpdate = await contestCollection.updateOne(query, {
          $inc: { participantsCount: 1 },
        });

        if (contestUpdate.modifiedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: "Contest not found to update" });
        }

        // 6. Save payment info
        const payment = {
          contestId: contestId,
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

        //  7. Create participation if not exists (APNAR ORIGINAL LOGIC)
        const alreadyParticipated = await participationCollection.findOne({
          contestId: contestId,
          userUID: session.metadata.userUID,
        });

        let participationResult = null;
        if (!alreadyParticipated) {
          const participation = {
            contestId: contestId,
            userUID: session.metadata.userUID,
            contestName: session.metadata.paymentName,
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
        res.send({
          success: true,
          message: "Payment processed successfully",
          trackingId,
          transactionId,
          isAlreadyProcessed: false,
          paymentResult,
          participationResult: participationResult
            ? "New participant added"
            : "Already in list",
        });
      } catch (error) {
        console.error("Payment success error:", error);
        res.status(500).send({
          success: false,
          message: "Internal server error",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });
    //-------------------------------------------------------

    //submit related api
    app.get("/submit-task", verifyFireBaseToken, async (req, res) => {
      const { contestId, userId } = req.query;

      const submission = await submittedCollection.findOne({
        contestId: contestId,
        userId: userId,
      });

      if (submission) {
        return res.send({ isSubmitted: true });
      }
      res.send({ isSubmitted: false });
    });

    app.post("/submit-task", verifyFireBaseToken, async (req, res) => {
      const submitInfo = req.body;

      const { contestId, userId } = submitInfo;

      if (!contestId || !userId) {
        return res.status(400).send({
          success: false,
          message: "contestId and userId are required",
        });
      }

      //same user + same contest check
      const existingSubmission = await submittedCollection.findOne({
        contestId: contestId,
        userId: userId,
      });

      if (existingSubmission) {
        return res.status(400).send({
          success: false,
          message: "You have already submitted a task for this contest",
        });
      }

      submitInfo.taskStatus = "Submitted";
      submitInfo.submitAt = new Date();

      const result = await submittedCollection.insertOne(submitInfo);

      res.send({
        success: true,
        insertedId: result.insertedId,
      });
    });

    app.get("/submit-task/:id", verifyFireBaseToken, async (req, res) => {
      const id = req.params.id;

      const query = { contestId: id };

      const cursor = submittedCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/submit-task", async (req, res) => {
      const cursor = submittedCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    //recent winner related api
    app.get("/recent-winner", async (req, res) => {
      // $ne: null (not equal). we dont need closed contest without declare winner
      const query = { status: "Closed", "winner.name": { $ne: null } };
      const cursor = contestCollection
        .find(query)
        .sort({ "winner.declaredAt": -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    //participation related api
    app.get("/participation/:id", verifyFireBaseToken, async (req, res) => {
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

      console.log(participation);

      // payment collection check
      const payment = await paymentCollection.findOne({
        contestId: contestId,
        userUID: userUID,
      });

      console.log(payment);

      if (participation && payment) {
        return res.send({ participated: true });
      }

      res.send({ participated: false });
    });

    app.get("/participation", verifyFireBaseToken, async (req, res) => {
      const email = req.query.email;

      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const query = {};
      if (email) {
        query.userEmail = email;
      }
      const cursor = participationCollection
        .find(query)
        .sort({ registeredAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    //sent a ping to confirm
    // await client.db("admin").command({ ping: 1 });
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

// rubeel@rafaan.com
